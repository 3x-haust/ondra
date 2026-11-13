#!/usr/bin/env bash
# Run with ondra-browser already on Ondra's development ?fixture page.
set -euo pipefail

ondra-browser eval '(() => {const {ui}=window.__ui; ui.setView({name:"board"}); ui.setPtabs([{id:1001,kind:"flow"},{id:1002,kind:"new"}]); ui.setActiveTab(1001); ui.setPanelOpen(false); document.activeElement?.blur();})()'
ondra-browser wait --fn '!!document.querySelector(".cv-job") && !document.querySelector(".panel")'
ondra-browser press Escape
ondra-browser find first '.cv-job' click
ondra-browser eval 'window.__ui.ui.setPanelOpen(true)'
ondra-browser wait --fn 'document.querySelectorAll(".ptab").length === 2'
ondra-browser focus '.ptab[aria-selected="false"]'
ondra-browser press Enter
ondra-browser eval '(() => {const {ui}=window.__ui; if(ui.view().name!=="board" || ui.panelTab()!=="new") throw Error("Enter on a panel tab must activate only that tab"); return "PASS: panel tab Enter keeps the canvas";})()'

ondra-browser focus '.ptab-add'
ondra-browser press Enter
ondra-browser eval '(() => {const {ui}=window.__ui; if(ui.view().name!=="board" || ui.ptabs().length!==3) throw Error("Enter on the new-tab button must not open the selected job"); return "PASS: panel button owns Enter";})()'

ondra-browser eval 'window.__ui.ui.setPanelOpen(false)'
ondra-browser wait --fn '!document.querySelector(".panel")'
ondra-browser eval 'document.activeElement?.blur()'
ondra-browser press Enter
ondra-browser eval '(() => {if(window.__ui.ui.view().name!=="task") throw Error("Enter on the canvas must still open the selected job"); return "PASS: canvas selection still opens with Enter";})()'
