#!/usr/bin/env bash
# Run with agent-browser already on Ondra's development ?fixture page.
set -euo pipefail

agent-browser eval '(() => {const {ui}=window.__ui; ui.setView({name:"board"}); ui.setPtabs([{id:1001,kind:"flow"},{id:1002,kind:"new"}]); ui.setActiveTab(1001); ui.setPanelOpen(false); document.activeElement?.blur();})()'
agent-browser wait --fn '!!document.querySelector(".cv-job") && !document.querySelector(".panel")'
agent-browser press Escape
agent-browser find first '.cv-job' click
agent-browser eval 'window.__ui.ui.setPanelOpen(true)'
agent-browser wait --fn 'document.querySelectorAll(".ptab").length === 2'
agent-browser focus '.ptab[aria-selected="false"]'
agent-browser press Enter
agent-browser eval '(() => {const {ui}=window.__ui; if(ui.view().name!=="board" || ui.panelTab()!=="new") throw Error("Enter on a panel tab must activate only that tab"); return "PASS: panel tab Enter keeps the canvas";})()'

agent-browser focus '.ptab-add'
agent-browser press Enter
agent-browser eval '(() => {const {ui}=window.__ui; if(ui.view().name!=="board" || ui.ptabs().length!==3) throw Error("Enter on the new-tab button must not open the selected job"); return "PASS: panel button owns Enter";})()'

agent-browser eval 'window.__ui.ui.setPanelOpen(false)'
agent-browser wait --fn '!document.querySelector(".panel")'
agent-browser eval 'document.activeElement?.blur()'
agent-browser press Enter
agent-browser eval '(() => {if(window.__ui.ui.view().name!=="task") throw Error("Enter on the canvas must still open the selected job"); return "PASS: canvas selection still opens with Enter";})()'
