// The page-side JavaScript lives once, in the Swift tool's sources (src-tauri/helpers/browser):
// each `let <name> = #"""` … `"""#` raw string there becomes a `pub const` here.
use std::{env, fs, path::Path};

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src-tauri/helpers/browser");
    let wanted = [("clickableJS", "CLICKABLE_JS"), ("deepQueryJS", "DEEP_QUERY_JS"), ("findFieldsJS", "FIND_FIELDS_JS"), ("submitJS", "SUBMIT_JS"), ("a11yJS", "A11Y_JS"), ("vitalsJS", "VITALS_JS")];
    let mut out = String::new();
    let mut found = 0;
    let mut files: Vec<_> = fs::read_dir(&dir).expect("src-tauri/helpers/browser").flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "swift")).collect();
    files.sort();
    for file in files {
        println!("cargo:rerun-if-changed={}", file.display());
        let text = fs::read_to_string(&file).unwrap().replace("\r\n", "\n");
        for (swift, rust) in wanted {
            let start = format!("let {swift} = #\"\"\"\n");
            let Some(at) = text.find(&start) else { continue };
            let body = &text[at + start.len()..];
            let end = body.find("\n\"\"\"#").expect("end of raw string");
            out += &format!("pub const {rust}: &str = r####\"{}\"####;\n", &body[..end]);
            found += 1;
        }
    }
    assert_eq!(found, wanted.len(), "every page script was found in the Swift sources");
    fs::write(Path::new(&env::var("OUT_DIR").unwrap()).join("page_js.rs"), out).unwrap();
}
