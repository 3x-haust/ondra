type Word = { text: string; quoted: boolean };
type HereDoc = { delimiter: Word; stripTabs: boolean; argv: string[] };

const SHELL = /^(?:sh|bash|zsh|dash)$/;
const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);

/** Remove literal command prefixes, not arbitrary argument data. */
function executable(argv: string[]): string[] {
  let i = 0;
  while (i < argv.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]) || /^(?:if|then|elif|else|while|until|do|!|\{)$/.test(argv[i])) {
      i++;
      continue;
    }
    const name = basename(argv[i]);
    if (!/^(?:env|sudo|command|exec)$/.test(name)) break;
    i++;
    while (i < argv.length && argv[i].startsWith("-")) {
      const option = argv[i++];
      if (option === "--") break;
      if ((name === "env" && /^(?:-u|--unset|-C|--chdir)$/.test(option)) ||
          (name === "sudo" && /^(?:-u|-g|-h|-p|-C|-T)$/.test(option)) ||
          (name === "exec" && option === "-a")) i++;
    }
  }
  return argv.slice(i);
}

function shellInput(argv: string[]): { code?: string; stdin: boolean } {
  if (!SHELL.test(basename(argv[0] ?? ""))) return { stdin: false };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (/^-[^-]*c/.test(arg)) return { code: argv[i + 1], stdin: false };
    if (/^-[^-]*s/.test(arg)) return { stdin: true };
    if (/^(?:-o|-O|--rcfile|--init-file)$/.test(arg)) { i++; continue; }
    if (arg === "--") return { stdin: i === argv.length - 1 };
    if (!arg.startsWith("-")) return { stdin: false };
  }
  return { stdin: true };
}

/**
 * Visit literal executable words, shell -c/stdin programs and substitutions.
 * This is a syntax scan, not evaluation: aliases, generated code, variables and
 * external scripts are not resolved. It is not a shell sandbox.
 */
export function visitShellCommands(source: string, visit: (argv: string[]) => void): void {
  let at = 0;

  function substitution(): boolean {
    if (source.startsWith("$(", at) || source.startsWith("<(", at) || source.startsWith(">(", at)) {
      at += 2;
      program(")");
      return true;
    }
    if (source[at] === "`") {
      at++;
      program("`");
      return true;
    }
    return false;
  }

  function word(delimiter = false, stop = ""): Word {
    let text = "";
    let quote = "";
    let quoted = false;
    while (at < source.length) {
      const c = source[at];
      if (!quote && stop && c === stop) break;
      if (!quote && /[\s;&|()<>]/.test(c) && !(!delimiter && /^[<>]\(/.test(source.slice(at, at + 2)))) break;
      if (c === "\\" && quote !== "'") {
        quoted = true;
        const next = source[at + 1];
        if (next === "\n") { at += 2; continue; }
        if (!quote || /[\$`"\\]/.test(next ?? "")) {
          text += next ?? "";
          at += next ? 2 : 1;
          continue;
        }
      }
      if ((c === "'" || c === '"') && (!quote || quote === c)) {
        quoted = true;
        quote = quote ? "" : c;
        at++;
        continue;
      }
      if (!delimiter && quote !== "'" && substitution()) {
        // Do not accidentally join literal pieces into a different executable.
        text += "\0";
        continue;
      }
      text += c;
      at++;
    }
    return { text, quoted };
  }

  function inspect(argv: string[]) {
    const args = executable(argv);
    if (!args.length) return;
    visit(args);
    const { code } = shellInput(args);
    if (code !== undefined) visitShellCommands(code, visit);
  }

  function documents(pending: HereDoc[]) {
    for (const doc of pending) {
      const start = at;
      let end = at;
      while (at < source.length) {
        const newline = source.indexOf("\n", at);
        const lineEnd = newline < 0 ? source.length : newline;
        const line = source.slice(at, lineEnd);
        if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter.text) {
          end = at;
          at = newline < 0 ? source.length : newline + 1;
          break;
        }
        at = newline < 0 ? source.length : newline + 1;
        end = at;
      }
      let body = source.slice(start, end);
      if (doc.stripTabs) body = body.replace(/^\t+/gm, "");
      if (!doc.delimiter.quoted) {
        // Unquoted heredocs expand substitutions even inside apparent quotes.
        const resume = at;
        at = start;
        while (at < end) {
          if (source[at] === "\\" && /[\\$`\n]/.test(source[at + 1] ?? "")) at += 2;
          else if (!substitution()) at++;
        }
        at = resume;
      }
      if (shellInput(executable(doc.argv)).stdin) visitShellCommands(body, visit);
    }
  }

  function program(stop = "") {
    let argv: string[] = [];
    let pending: HereDoc[] = [];
    const finish = () => { inspect(argv); argv = []; };
    while (at < source.length) {
      const c = source[at];
      if (stop && c === stop) { finish(); at++; return; }
      if (c === "\n") {
        finish();
        at++;
        documents(pending);
        pending = [];
        continue;
      }
      if (/\s/.test(c)) { at++; continue; }
      if (c === "#") {
        const newline = source.indexOf("\n", at);
        at = newline < 0 ? source.length : newline;
        continue;
      }
      if (/[;&|]/.test(c)) { finish(); at++; continue; }
      if (c === "(") { finish(); at++; program(")"); continue; }
      if (c === ")") { finish(); at++; continue; }
      const redirect = source.slice(at).match(/^(?:\d+)?(<<<|<<-?|<>|<&|>&|>\||>>?|<)/);
      if (redirect && !/^[<>]\(/.test(source.slice(at, at + 2))) {
        at += redirect[0].length;
        while (/[ \t]/.test(source[at] ?? "") && at < source.length) at++;
        const op = redirect[1];
        const heredoc = op === "<<" || op === "<<-";
        const target = word(heredoc);
        if (heredoc) pending.push({ delimiter: target, stripTabs: op === "<<-", argv });
        else if (op === "<<<" && shellInput(executable(argv)).stdin) visitShellCommands(target.text, visit);
        continue;
      }
      argv.push(word(false, stop).text);
    }
    finish();
  }

  program();
}
