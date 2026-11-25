//! Connected services (MCP servers), each workspace its own: a space's `mcp.json` and its sign-ins
//! (`mcp-auth.json`) live in its data folder, which every engine of the space gets as `PI_MCP_DIR`.
//! A client secret a server needs (Gmail, Slack: the user's own OAuth app) stays in the keychain
//! and reaches that space's engines as an env var the config names, never the page.
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

/** a space's MCP folder */
pub fn dir(app: &AppHandle, space: &str) -> PathBuf {
    crate::tools::space_base(app, space).join("mcp")
}

/** the env var a server's client secret goes in: `ONDRA_MCP_SECRET_<SERVER>` */
pub fn secret_var(server: &str) -> String {
    let name: String = server.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' }).collect();
    format!("ONDRA_MCP_SECRET_{name}")
}

/** where a server's client secret is kept in the vault: one of Ondra's own items (`@…`, never a job's env), by its folder and name */
fn account(dir: &Path, server: &str) -> String {
    format!("@mcp:{}:{server}", dir.display())
}

/** The client secrets this space's servers name (`${ONDRA_MCP_SECRET_*}`), from the keychain onto the command. */
pub fn inject(cmd: &mut Command, env: &[(String, String)]) {
    let Some(dir) = env.iter().rev().find(|(k, _)| k == "PI_MCP_DIR").map(|(_, v)| PathBuf::from(v)) else { return };
    let Ok(text) = std::fs::read_to_string(dir.join("mcp.json")) else { return };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return };
    let Some(servers) = v["mcpServers"].as_object() else { return };
    for (name, s) in servers {
        let var = secret_var(name);
        if s["oauth"]["clientSecret"].as_str() == Some(format!("${{{var}}}").as_str()) {
            if let Some(value) = crate::secrets::vault_get(&account(&dir, name)) {
                cmd.env(var, value);
            }
        }
    }
}

#[tauri::command]
pub fn mcp_dir(app: AppHandle, space: String) -> String {
    dir(&app, &space).display().to_string()
}

/** The space's servers (`mcpServers` of its mcp.json), empty when it has none. */
#[tauri::command]
pub fn mcp_servers(app: AppHandle, space: String) -> Value {
    std::fs::read_to_string(dir(&app, &space).join("mcp.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .map(|v| v["mcpServers"].clone())
        .filter(Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}))
}

/** Write the space's servers, keeping anything else its mcp.json holds. */
#[tauri::command]
pub fn mcp_save(app: AppHandle, space: String, servers: Value) -> Result<(), String> {
    if !servers.is_object() {
        return Err("servers must be an object".into());
    }
    let d = dir(&app, &space);
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let path = d.join("mcp.json");
    let mut v = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(Value::is_object).unwrap_or_else(|| serde_json::json!({}));
    v["mcpServers"] = servers;
    let text = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    let tmp = d.join("mcp.json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/** Keep a server's client secret (the user's OAuth app) for this space. */
#[tauri::command]
pub async fn mcp_secret_set(app: AppHandle, space: String, server: String, value: String) -> Result<(), String> {
    let d = dir(&app, &space);
    crate::secrets::off_main(move || crate::secrets::vault_set(&account(&d, &server), value.trim())).await?
}

/** Use a saved secret (Settings › 시크릿, by name) as a server's client secret: the value moves
 * here, natively, so an agent that connects a service for the user never sees it. */
#[tauri::command]
pub async fn mcp_secret_from(app: AppHandle, space: String, server: String, name: String) -> Result<(), String> {
    let d = dir(&app, &space);
    crate::secrets::off_main(move || {
        let v = crate::secrets::saved_value(name.trim()).filter(|v| !v.trim().is_empty()).ok_or_else(|| format!("시크릿 {}이(가) 없어요", name.trim()))?;
        crate::secrets::vault_set(&account(&d, &server), v.trim())
    })
    .await?
}

#[tauri::command]
pub async fn mcp_secret_delete(app: AppHandle, space: String, server: String) -> Result<(), String> {
    let d = dir(&app, &space);
    crate::secrets::off_main(move || crate::secrets::vault_delete(&account(&d, &server))).await?
}

#[derive(Serialize)]
pub struct CliOut {
    code: i32,
    out: String,
}

/**
 * The engine's `mcp` command for a space (`list --json`, `login <server>`, `logout <server>`): its
 * folder and secrets set, its output back. A sign-in opens the browser and waits for it (up to the
 * engine's own limit).
 */
#[tauri::command]
pub async fn mcp_cli(app: AppHandle, space: String, args: Vec<String>) -> Result<CliOut, String> {
    let allowed = matches!(args.first().map(String::as_str), Some("list" | "login" | "logout"));
    if !allowed {
        return Err("list, login, logout만 돼요".into());
    }
    let bin = crate::engine::engine_bin(&app).filter(|b| b.is_file()).ok_or("엔진 파일이 앱에 없습니다. 앱을 다시 설치하세요.")?;
    let d = dir(&app, &space);
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(bin);
    for (k, v) in crate::engine::engine_env(&app) {
        cmd.env(k, v);
    }
    let env = vec![("PI_MCP_DIR".to_string(), d.display().to_string())];
    for (k, v) in &env {
        cmd.env(k, v);
    }
    inject(&mut cmd, &env);
    cmd.arg("mcp").args(&args).current_dir(&d);
    let out = tauri::async_runtime::spawn_blocking(move || cmd.output()).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    let err = String::from_utf8_lossy(&out.stderr);
    if !err.trim().is_empty() {
        text.push_str(&err);
    }
    Ok(CliOut { code: out.status.code().unwrap_or(-1), out: text })
}

#[cfg(test)]
mod tests {
    #[test]
    fn secret_vars() {
        assert_eq!(super::secret_var("slack"), "ONDRA_MCP_SECRET_SLACK");
        assert_eq!(super::secret_var("google-mail"), "ONDRA_MCP_SECRET_GOOGLE_MAIL");
    }
}
