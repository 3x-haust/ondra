use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    io::{Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const HELP: &str = "Ondra bundled static binary analysis (radare2 + r2ghidra 6.2.6)
Usage: ondra-binary <inspect|functions|disassemble|decompile> <file> [--arch arm64|x86_64] [--address 0xHEX] [--name SUBSTR]
       ondra-binary --help | --version

inspect: metadata; functions: analyzed function list;
disassemble: function instructions; decompile: Ghidra decompiler pseudocode.
Disassemble/decompile require a function's virtual address from functions.
functions accepts --name SUBSTR (case-insensitive) to return only matching
functions; a real app can have thousands, so filter before reading the JSON.
Without --name, more than 300 functions returns a compact preview (total, first
200 name/addr/size entries, hint). disassemble keeps at most 300 instructions and
decompile at most 400 lines
(dropping annotations/p-code); both set truncated and totalOps/totalLines.
Universal Mach-O requires --arch. Supported targets: 64-bit ARM/x86 Mach-O, ELF, PE.
Outputs JSON; diagnostics go to stderr. Exit 1 means incomplete/failed, 2 invalid arguments.
No target execution, user plugins, user configuration, network or external runtimes.
Each engine invocation is limited to 120 seconds; input and raw engine output to
512 MiB each. The printed result is always bounded to a model-sized summary.
Static parsing is not a security sandbox. Analyze hostile inputs only in an isolated lab.";

#[derive(Debug)]
struct Args {
    operation: String,
    input: PathBuf,
    arch: Option<String>,
    address: Option<u64>,
    name: Option<String>,
}

fn parse(args: &[String]) -> Result<Args, String> {
    if args.len() < 2 || !["inspect", "functions", "disassemble", "decompile"].contains(&args[0].as_str()) {
        return Err(HELP.into());
    }
    let mut result = Args { operation: args[0].clone(), input: PathBuf::from(&args[1]), arch: None, address: None, name: None };
    for pair in args[2..].chunks(2) {
        if pair.len() != 2 { return Err("Every option needs a value".into()); }
        match pair[0].as_str() {
            "--arch" if result.arch.is_none() && ["arm64", "x86_64"].contains(&pair[1].as_str()) => result.arch = Some(pair[1].clone()),
            "--address" if result.address.is_none() => {
                let hex = pair[1].strip_prefix("0x").filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_hexdigit()))
                    .ok_or("Address must be a hexadecimal virtual address (0xHEX)")?;
                result.address = Some(u64::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
            }
            "--name" if result.name.is_none() && !pair[1].is_empty() => result.name = Some(pair[1].clone()),
            _ => return Err(format!("Invalid or repeated option: {}", pair[0])),
        }
    }
    let needs_address = ["disassemble", "decompile"].contains(&result.operation.as_str());
    if needs_address != result.address.is_some() {
        return Err("Only disassemble/decompile require --address".into());
    }
    if result.name.is_some() && result.operation != "functions" {
        return Err("--name only filters the functions operation".into());
    }
    Ok(result)
}

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Result<Self, String> {
        // Do not use inherited TMPDIR: tools must not discover user configuration.
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
        let dir = PathBuf::from(format!("/tmp/ondra-binary-{}-{stamp}", std::process::id()));
        fs::create_dir(&dir).map_err(|e| e.to_string())?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        Ok(Self(dir))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

fn resources() -> Result<PathBuf, String> {
    let exe = env::current_exe().map_err(|e| e.to_string())?;
    let parent = exe.parent().ok_or("Executable has no parent")?;
    // Installed .app, then Tauri's local binaries/ or target/{debug,release}/.
    for path in [parent.join("../Resources/binary-analysis"), parent.join("../resources/binary-analysis"), parent.join("../../resources/binary-analysis")] {
        if path.join("bin/radare2").is_file() {
            return fs::canonicalize(path).map_err(|e| e.to_string());
        }
    }
    Err("Bundled analysis engine is missing; rebuild or reinstall Ondra. No external engine will be used.".into())
}

// The raw radare2 JSON is only an intermediate: `bound` always reduces it to a
// context-sized result before we print. So this cap only guards against runaway
// engine output, not the model's context, and can be far larger than the emitted
// caps in `bound`. A fully analyzed 21 MiB Mach-O already yields ~52 MiB of aflj.
const ENGINE_OUTPUT_LIMIT: u64 = 512 * 1024 * 1024;

fn engine(root: &Path, scratch: &Path, arch: &Option<String>, commands: &str) -> Result<Value, String> {
    let stdout = scratch.join("stdout");
    let stderr = scratch.join("stderr");
    let mut cmd = Command::new(root.join("bin/radare2"));
    cmd.env_clear().env("HOME", scratch).env("XDG_CONFIG_HOME", scratch).env("XDG_DATA_HOME", scratch)
        .env("XDG_CACHE_HOME", scratch).env("TMPDIR", scratch).env("PATH", "")
        .env("LC_ALL", "C").env("R2_PREFIX", root)
        .env("SLEIGHHOME", root.join("lib/radare2/6.2.6/r2ghidra_sleigh"))
        .current_dir(scratch).args(["-N", "-q", "-e", "scr.color=0", "-e", "scr.interactive=false", "-e", "bin.relocs.apply=true", "-e", "bin.demangle=false"]);
    if let Some(arch) = arch { cmd.args(["-a", if arch == "arm64" { "arm" } else { "x86" }, "-b", "64"]); }
    cmd.args(["-c", commands, "sample.bin"]).stdin(Stdio::null())
        .stdout(fs::File::create(&stdout).map_err(|e| e.to_string())?)
        .stderr(fs::File::create(&stderr).map_err(|e| e.to_string())?);
    let mut child = cmd.spawn().map_err(|e| format!("Cannot start bundled engine: {e}"))?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {},
            Err(e) => { let _ = child.kill(); let _ = child.wait(); return Err(e.to_string()); }
        }
        let oversized = [&stdout, &stderr].iter().any(|p| fs::metadata(p).is_ok_and(|m| m.len() > ENGINE_OUTPUT_LIMIT));
        if oversized || started.elapsed() >= Duration::from_secs(120) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(if oversized { "Engine output limit exceeded" } else { "Engine timed out after 120 seconds" }.into());
        }
        thread::sleep(Duration::from_millis(25));
    };
    let diagnostics = fs::read_to_string(&stderr).map_err(|e| e.to_string())?;
    if !diagnostics.is_empty() { eprint!("{diagnostics}"); }
    if !status.success() { return Err(format!("Engine exited with {status}")); }
    let output = fs::read(&stdout).map_err(|e| e.to_string())?;
    if output.len() as u64 > ENGINE_OUTPUT_LIMIT { return Err("Engine output limit exceeded".into()); }
    serde_json::from_slice(&output).map_err(|e| format!("Engine did not return valid JSON: {e}"))
}

fn open_input(input: &Path) -> Result<fs::File, String> {
    let validate = |meta: fs::Metadata| {
        if !meta.is_file() || meta.len() > 512 * 1024 * 1024 {
            Err("Input must be a regular file of at most 512 MiB".to_string())
        } else { Ok(()) }
    };
    validate(fs::metadata(input).map_err(|e| e.to_string())?)?;
    // A path can be replaced after metadata; never wait for a FIFO writer.
    let source = fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK)
        .open(input).map_err(|e| e.to_string())?;
    validate(source.metadata().map_err(|e| e.to_string())?)?;
    Ok(source)
}

// Keep default output small enough for a model's context. A full listing is
// still available through --name or by narrowing to one function.
const FUNCTION_LIMIT: usize = 300;
const FUNCTION_PREVIEW: usize = 200;
const OP_LIMIT: usize = 300;
const CODE_LINE_LIMIT: usize = 400;
const SECTION_LIMIT: usize = 200;

// ───────────── the trace Ondra draws from
// Run by an Ondra job, every operation also appends what it started and what it
// found to `$APP_ARTIFACTS_DIR/.reverse/trace.jsonl`, for the job's 리버싱 view.
// It is never printed, so the model's output stays as bounded as before. The
// view keeps more than the printed summary (every function, longer listings)
// but still within these caps.
const TRACE_FUNCTIONS: usize = 200_000;
const TRACE_OPS: usize = 4_000;
const TRACE_LINES: usize = 3_000;

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis())
}

fn file_name(p: &Path) -> String {
    p.file_name().map_or_else(|| p.display().to_string(), |n| n.to_string_lossy().into_owned())
}

fn trace_file() -> Option<PathBuf> {
    let dir = PathBuf::from(env::var_os("APP_ARTIFACTS_DIR").filter(|d| !d.is_empty())?).join(".reverse");
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("trace.jsonl"))
}

/// One line per event; a failed write never fails the analysis.
fn trace(event: Value) {
    let Some(path) = trace_file() else { return };
    let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).mode(0o600).open(path) else { return };
    let mut line = serde_json::to_string(&event).unwrap_or_default();
    line.push('\n');
    let _ = f.write_all(line.as_bytes());
}

fn target_view(bin: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for k in ["class", "arch", "bits", "os", "machine", "lang", "stripped", "baddr", "compiler", "endian", "bintype"] {
        if !bin[k].is_null() { out.insert(k.into(), bin[k].clone()); }
    }
    Value::Object(out)
}

/// What the 리버싱 view needs from a result, kept compact.
fn view(operation: &str, data: &Value) -> Value {
    match operation {
        "inspect" => json!({"sections": data["sections"]}),
        "functions" => {
            let list: Vec<Value> = data.as_array().map(|l| l.iter().take(TRACE_FUNCTIONS)
                .map(|f| json!([f["name"], f["addr"], f["size"]])).collect()).unwrap_or_default();
            json!({"functions": list})
        }
        "disassemble" => {
            let all = data["ops"].as_array().cloned().unwrap_or_default();
            let ops: Vec<Value> = all.iter().take(TRACE_OPS).map(|o| {
                let mut v = json!({"a": o["addr"], "b": o["bytes"], "d": o["disasm"], "t": o["type"]});
                if !o["jump"].is_null() { v["j"] = o["jump"].clone(); }
                if !o["fail"].is_null() { v["f"] = o["fail"].clone(); }
                v
            }).collect();
            json!({"name": data["name"], "addr": data["addr"], "size": data["size"], "ops": ops, "totalOps": all.len()})
        }
        "decompile" => {
            let code = data["code"].as_str().unwrap_or("");
            // the line each character starts on, to place the decompiler's address annotations
            let mut starts = vec![0usize];
            starts.extend(code.char_indices().filter(|(_, c)| *c == '\n').map(|(i, _)| i + 1));
            let total = starts.len();
            let mut lines: Vec<Vec<u64>> = vec![Vec::new(); total.min(TRACE_LINES)];
            for a in data["annotations"].as_array().into_iter().flatten() {
                if a["type"] != "offset" { continue; }
                let (Some(start), Some(addr)) = (a["start"].as_u64(), a["offset"].as_u64()) else { continue };
                let line = starts.partition_point(|s| *s <= start as usize).saturating_sub(1);
                if let Some(l) = lines.get_mut(line) { if !l.contains(&addr) && l.len() < 16 { l.push(addr); } }
            }
            let kept: String = code.split_inclusive('\n').take(TRACE_LINES).collect();
            json!({"code": kept, "lines": lines, "totalLines": total})
        }
        _ => Value::Null,
    }
}

fn bound(operation: &str, named: bool, mut data: Value) -> Value {
    match operation {
        "functions" if !named => {
            let list = data.as_array().cloned().unwrap_or_default();
            if list.len() <= FUNCTION_LIMIT { return data; }
            let preview: Vec<Value> = list.iter().take(FUNCTION_PREVIEW)
                .map(|f| json!({"name": f["name"], "addr": f["addr"], "size": f["size"]})).collect();
            json!({
                "total": list.len(), "shown": preview.len(), "truncated": true, "functions": preview,
                "hint": "Too many functions to list in full. Rerun with --name SUBSTR to get complete entries for matching functions."
            })
        }
        "disassemble" => {
            let total = data["ops"].as_array().map_or(0, Vec::len);
            if total > OP_LIMIT {
                if let Some(ops) = data["ops"].as_array_mut() {
                    ops.truncate(OP_LIMIT);
                    for op in ops.iter_mut() {
                        *op = json!({"addr": op["addr"], "size": op["size"], "bytes": op["bytes"],
                            "disasm": op["disasm"], "type": op["type"], "xrefs": op["xrefs"]});
                    }
                }
                data["truncated"] = json!(true);
                data["totalOps"] = json!(total);
            } else { data["truncated"] = json!(false); }
            data
        }
        "decompile" => {
            let code = data["code"].as_str().unwrap_or("").to_string();
            let total = code.lines().count();
            if total > CODE_LINE_LIMIT {
                let kept: String = code.split_inclusive('\n').take(CODE_LINE_LIMIT).collect();
                // Annotations and raw p-code dwarf the code; disassemble gives addresses.
                if let Some(obj) = data.as_object_mut() { obj.remove("annotations"); obj.remove("pcode_ops"); }
                data["code"] = json!(kept);
                data["truncated"] = json!(true);
                data["totalLines"] = json!(total);
            } else { data["truncated"] = json!(false); }
            data
        }
        _ => data,
    }
}

fn analyze(args: Args, seq: &str) -> Result<Value, String> {
    let root = resources()?;
    let input = fs::canonicalize(&args.input).map_err(|e| format!("Input: {e}"))?;
    let mut source = open_input(&input)?;
    let scratch = Scratch::new()?;
    let mut target = fs::File::create(scratch.0.join("sample.bin")).map_err(|e| e.to_string())?;
    target.set_permissions(fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut size = 0_u64;
    let mut magic = Vec::new();
    let mut buf = [0_u8; 64 * 1024];
    loop {
        let count = source.read(&mut buf).map_err(|e| e.to_string())?;
        if count == 0 { break; }
        size += count as u64;
        if size > 512 * 1024 * 1024 { return Err("Input exceeds 512 MiB".into()); }
        if magic.is_empty() { magic.extend_from_slice(&buf[..count.min(4)]); }
        hasher.update(&buf[..count]);
        target.write_all(&buf[..count]).map_err(|e| e.to_string())?;
    }
    drop(target);
    let universal = [[0xca, 0xfe, 0xba, 0xbe], [0xbe, 0xba, 0xfe, 0xca], [0xca, 0xfe, 0xba, 0xbf], [0xbf, 0xba, 0xfe, 0xca]].iter().any(|m| magic == m);
    if universal && args.arch.is_none() { return Err("Universal Mach-O requires --arch arm64 or --arch x86_64".into()); }
    let info = engine(&root, &scratch.0, &args.arch, "ij")?;
    let bin = &info["bin"];
    let format = bin["class"].as_str().unwrap_or("");
    let arch = bin["arch"].as_str().unwrap_or("");
    if !["MACH064", "ELF64", "PE32+"].contains(&format) || !["arm", "x86"].contains(&arch) || bin["bits"] != 64 {
        return Err(format!("Unsupported target: format={format}, arch={arch}, bits={}. Supported: 64-bit ARM/x86 Mach-O, ELF, PE", bin["bits"]));
    }
    if let Some(requested) = &args.arch {
        let expected = if requested == "arm64" { "arm" } else { "x86" };
        if arch != expected { return Err("Requested architecture is not present in the target".into()); }
    }
    let command = match args.operation.as_str() {
        "inspect" => None,
        "functions" => Some("aaa;aflj".to_string()),
        "disassemble" => Some(format!("aaa;pdfj @ {:#x}", args.address.unwrap())),
        "decompile" => Some(format!("aaa;pdgj @ {:#x}", args.address.unwrap())),
        _ => unreachable!(),
    };
    let mut data = match command { Some(ref c) => engine(&root, &scratch.0, &args.arch, c)?, None => info.clone() };
    if args.operation == "inspect" {
        // the sections place code in the file: names, addresses, sizes, permissions
        if let Ok(Value::Array(list)) = engine(&root, &scratch.0, &args.arch, "iSj") {
            data["sections"] = list.iter().take(SECTION_LIMIT)
                .map(|x| json!({"name": x["name"], "vaddr": x["vaddr"], "vsize": x["vsize"], "perm": x["perm"]})).collect();
        }
    }
    if let Some(needle) = &args.name {
        let needle = needle.to_lowercase();
        let matches: Vec<Value> = data.as_array().map(|list| list.iter()
            .filter(|f| f["name"].as_str().is_some_and(|n| n.to_lowercase().contains(&needle)))
            .cloned().collect()).unwrap_or_default();
        if matches.is_empty() { return Err(format!("No analyzed function name contains {needle:?}")); }
        data = Value::Array(matches);
    }
    let complete = match args.operation.as_str() {
        "inspect" => true,
        "functions" => data.as_array().is_some_and(|v| !v.is_empty()),
        "disassemble" => data["ops"].as_array().is_some_and(|v| !v.is_empty()),
        "decompile" => data["code"].as_str().is_some_and(|s| s.contains('{') && s.contains('}')) && data.get("errors").is_none(),
        _ => false,
    };
    if !complete { return Err(format!("No complete {} result: {data}", args.operation)); }
    let sha256 = format!("{:x}", hasher.finalize());
    trace(json!({
        "t": "done", "seq": seq, "at": now_ms(), "op": args.operation, "file": file_name(&input),
        "sha256": sha256, "size": size, "target": target_view(bin), "address": args.address,
        "filter": args.name, "view": view(&args.operation, &data),
    }));
    let data = bound(&args.operation, args.name.is_some(), data);
    Ok(json!({
        "engine": {"radare2": "6.2.6", "r2ghidra": "6.2.6"},
        "operation": args.operation, "input": input, "sha256": sha256,
        "size": size, "target": bin, "address": args.address, "data": data,
        "executedTarget": false,
        "pseudocode": args.operation == "decompile"
    }))
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args == ["--help"] || args == ["-h"] { println!("{HELP}"); return; }
    if args == ["--version"] { println!("ondra-binary 0.1.0 (radare2 6.2.6, r2ghidra 6.2.6)"); return; }
    let args = parse(&args).unwrap_or_else(|e| { eprintln!("{e}"); std::process::exit(2) });
    let seq = format!("{}-{}", std::process::id(), now_ms());
    let op = args.operation.clone();
    trace(json!({"t": "start", "seq": seq, "at": now_ms(), "op": op, "file": file_name(&args.input), "address": args.address, "filter": args.name}));
    match analyze(args, &seq) {
        Ok(result) => println!("{}", serde_json::to_string_pretty(&result).unwrap()),
        Err(e) => {
            trace(json!({"t": "fail", "seq": seq, "at": now_ms(), "op": op, "error": e}));
            eprintln!("Analysis incomplete: {e}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(s: &[&str]) -> Vec<String> { s.iter().map(|s| s.to_string()).collect() }
    #[test]
    fn opens_regular_files_and_rejects_nonregular_inputs() {
        let scratch = Scratch::new().unwrap();
        let file = scratch.0.join("sample");
        fs::write(&file, b"sample").unwrap();
        let mut contents = String::new();
        open_input(&file).unwrap().read_to_string(&mut contents).unwrap();
        assert_eq!(contents, "sample");
        assert!(open_input(&scratch.0).unwrap_err().contains("regular file"));
    }
    #[test]
    fn validates_operations_addresses_and_options() {
        assert!(parse(&args(&["inspect", "a"])).is_ok());
        assert_eq!(parse(&args(&["decompile", "a", "--address", "0x123"])).unwrap().address, Some(0x123));
        for invalid in [vec!["run", "a"], vec!["decompile", "a"], vec!["inspect", "a", "--address", "0x1"], vec!["decompile", "a", "--address", "0x1;!touch /tmp/injected"], vec!["inspect", "a", "--arch", "mips"], vec!["inspect", "a", "--arch"], vec!["inspect", "a", "--arch", "arm64", "--arch", "x86_64"]] {
            assert!(parse(&args(&invalid)).is_err(), "{invalid:?}");
        }
    }
    #[test]
    fn bounds_a_large_function_list_to_a_context_sized_preview() {
        // A big binary yields ~100k functions and tens of MiB of raw engine JSON
        // (allowed up to ENGINE_OUTPUT_LIMIT); the printed result stays tiny.
        assert!(ENGINE_OUTPUT_LIMIT >= 512 * 1024 * 1024);
        // Each real aflj entry carries dozens of fields; approximate that bulk so
        // the raw array genuinely exceeds the old 32 MiB cap, as a real big binary does.
        let bulk: Vec<i64> = (0..40).collect();
        let list: Vec<Value> = (0..101_917)
            .map(|i| json!({"name": format!("sym.imp.some_longish_demangled_function_name_{i:08x}"),
                "addr": i, "size": 16, "ops": bulk, "callrefs": bulk, "datarefs": bulk, "codexrefs": bulk}))
            .collect();
        let raw = Value::Array(list);
        let full = serde_json::to_vec(&raw).unwrap();
        let bounded = bound("functions", false, raw);
        let emitted = serde_json::to_vec(&bounded).unwrap();
        assert!(full.len() > 32 * 1024 * 1024, "raw list should exceed the old 32 MiB cap");
        assert!(emitted.len() < 64 * 1024, "emitted preview must stay context-sized");
        assert_eq!(bounded["total"], json!(101_917));
        assert_eq!(bounded["shown"], json!(FUNCTION_PREVIEW));
        assert_eq!(bounded["truncated"], json!(true));
        assert_eq!(bounded["functions"].as_array().unwrap().len(), FUNCTION_PREVIEW);
        // The preview drops per-function detail (e.g. ops) to the three fields.
        assert_eq!(bounded["functions"][0].as_object().unwrap().len(), 3);
    }
}
