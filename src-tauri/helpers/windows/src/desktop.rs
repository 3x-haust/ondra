#![allow(non_upper_case_globals)] // Windows SDK constant names in match patterns
use super::*;
use windows::core::Interface;
use windows::Win32::{System::Com::*, UI::Accessibility::*};
#[path = "window.rs"]
mod window;
use window::Window;

trait Checked<T> {
    fn checked(self) -> Result<T>;
}
impl<T> Checked<T> for windows::core::Result<T> {
    fn checked(self) -> Result<T> {
        self.map_err(|_| UNSAFE)
    }
}
fn require(v: bool) -> Result<()> {
    v.then_some(()).ok_or(UNSAFE)
}

#[derive(Default)]
pub struct Host {
    session: Option<Session>,
    prepared: Option<Scroll>,
    blocked: bool,
}
struct Session {
    w: Window,
    api: IUIAutomation,
    root: IUIAutomationElement,
    all: IUIAutomationCondition,
    // One scrollable list/document per window. Never substitute another element for an old ref.
    area: Option<IUIAutomationElement>,
    revision: u64,
}

impl Host {
    pub fn run(&mut self, op: Op) -> Result<Value> {
        if self.blocked && !matches!(op, Op::Release { .. }) {
            return Err(UNSAFE);
        }
        let result = self.dispatch(op);
        // A password or uninspectable dialog must not become usable by revealing it.
        if matches!(result, Err(UNSAFE | "ACTION_OUTCOME_UNKNOWN")) {
            self.blocked = true;
        }
        result
    }
    fn dispatch(&mut self, op: Op) -> Result<Value> {
        let prepared = self.prepared.take();
        // COM interfaces stay on this thread. No window handles or commands come from stdin.
        unsafe {
            if let Op::Launch { app } = op {
                require(self.session.is_none())?;
                let w = Window::attach(&app)?;
                CoInitializeEx(None, COINIT_MULTITHREADED).ok().checked()?;
                let api: IUIAutomation =
                    CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER).checked()?;
                let bounded: IUIAutomation2 = api.cast().checked()?;
                bounded.SetConnectionTimeout(1500).checked()?;
                bounded.SetTransactionTimeout(1500).checked()?;
                let root = api.ElementFromHandle(w.hwnd).checked()?;
                let result = json!({"pid":w.pid,"mode":"attached:uia"});
                self.session = Some(Session {
                    w,
                    root,
                    all: api.CreateTrueCondition().checked()?,
                    api,
                    area: None,
                    revision: 0,
                });
                return Ok(result);
            }
            let s = self.session.as_mut().ok_or(UNSAFE)?;
            match op {
                Op::Observe { pid, full } if pid == s.w.pid => {
                    let _ = full; // TS keeps the full/delta history.
                    s.observe()
                }
                Op::Prepare { pid, action } if pid == s.w.pid => {
                    s.resolve(&action)?;
                    self.prepared = Some(action);
                    Ok(json!({"required":false}))
                }
                Op::Act { pid, action } if pid == s.w.pid && prepared.as_ref() == Some(&action) => {
                    let pattern = s.resolve(&action)?;
                    s.w.check_user_idle()?;
                    pattern
                        .Scroll(
                            ScrollAmount_NoAmount,
                            match action.direction {
                                Direction::Down => ScrollAmount_SmallIncrement,
                                Direction::Up => ScrollAmount_SmallDecrement,
                            },
                        )
                        .map_err(|_| "ACTION_OUTCOME_UNKNOWN")?;
                    let mut result = s.observe().map_err(|_| "ACTION_OUTCOME_UNKNOWN")?;
                    result["via"] = json!("UI Automation ScrollPattern");
                    Ok(result)
                }
                Op::Release { pid } if pid == s.w.pid => {
                    self.session = None;
                    Ok(json!({"stopped":true}))
                }
                _ => Err(UNSUPPORTED),
            }
        }
    }
}

#[derive(Default)]
struct View {
    count: usize,
    area: Option<IUIAutomationElement>,
    labels: Vec<IUIAutomationElement>,
}
impl Session {
    // Inspect all nodes before asking any control for its name. Never read HWND text,
    // values, selection, password contents, menus, or arbitrary text outside the area.
    unsafe fn walk(
        &self,
        e: &IUIAutomationElement,
        depth: usize,
        inside: bool,
        chrome: bool,
        visible: bool,
        v: &mut View,
    ) -> Result<()> {
        v.count += 1;
        require(
            depth <= 24
                && v.count <= 512
                && e.CurrentProcessId().checked()? == self.w.pid as i32
                && !e.CurrentIsPassword().checked()?.as_bool()
                && !e
                    .cast::<IUIAutomationElement9>()
                    .checked()?
                    .CurrentIsDialog()
                    .checked()?
                    .as_bool(),
        )?;
        let ty = e.CurrentControlType().checked()?;
        let visible = visible && !e.CurrentIsOffscreen().checked()?.as_bool();
        let is_area = matches!(ty, UIA_ListControlTypeId | UIA_DocumentControlTypeId);
        let chrome = chrome
            || matches!(
                ty,
                UIA_TitleBarControlTypeId | UIA_ScrollBarControlTypeId | UIA_MenuBarControlTypeId
            );
        // Positive shape: a standard list/document, passive content, and its window chrome.
        // No forms, embedded windows, editable fields, custom controls or approval buttons.
        require(match ty {
            UIA_WindowControlTypeId => depth == 0,
            UIA_ListControlTypeId | UIA_DocumentControlTypeId => !inside && !chrome,
            UIA_TextControlTypeId
            | UIA_ListItemControlTypeId
            | UIA_GroupControlTypeId
            | UIA_PaneControlTypeId
            | UIA_StatusBarControlTypeId => true,
            UIA_TitleBarControlTypeId
            | UIA_ScrollBarControlTypeId
            | UIA_MenuBarControlTypeId
            | UIA_MenuItemControlTypeId
            | UIA_ButtonControlTypeId
            | UIA_ThumbControlTypeId
            | UIA_MenuControlTypeId => chrome,
            _ => false,
        })?;
        if is_area && visible {
            require(v.area.is_none() && e.CurrentIsEnabled().checked()?.as_bool())?;
            v.area = Some(e.clone());
        }
        if inside
            && !chrome
            && visible
            && matches!(ty, UIA_TextControlTypeId | UIA_ListItemControlTypeId)
        {
            v.labels.push(e.clone());
        }
        let children = e.FindAll(TreeScope_Children, &self.all).checked()?;
        let len = children.Length().checked()?;
        require(len >= 0 && v.count + len as usize <= 512)?;
        for i in 0..len {
            self.walk(
                &children.GetElement(i).checked()?,
                depth + 1,
                inside || is_area,
                chrome,
                visible,
                v,
            )?;
        }
        Ok(())
    }
    unsafe fn inspect(&self) -> Result<(IUIAutomationElement, View)> {
        self.w.check()?;
        let root = self.api.ElementFromHandle(self.w.hwnd).checked()?;
        require(
            self.api
                .CompareElements(&self.root, &root)
                .checked()?
                .as_bool()
                && root.CurrentControlType().checked()? == UIA_WindowControlTypeId
                && !root.CurrentIsOffscreen().checked()?.as_bool(),
        )?;
        let p: IUIAutomationWindowPattern =
            root.GetCurrentPatternAs(UIA_WindowPatternId).checked()?;
        require(
            !p.CurrentIsModal().checked()?.as_bool()
                && matches!(
                    p.CurrentWindowInteractionState().checked()?,
                    WindowInteractionState_ReadyForUserInteraction | WindowInteractionState_Running
                ),
        )?;
        let mut view = View::default();
        self.walk(&root, 0, false, false, true, &mut view)?;
        let area = view.area.take().ok_or(UNSAFE)?;
        Ok((area, view))
    }
    fn id(&self) -> String {
        format!("area-{}", self.revision)
    }
    unsafe fn resolve(&mut self, action: &Scroll) -> Result<IUIAutomationScrollPattern> {
        if action.element != self.id() {
            return Err("STALE_REF");
        }
        let previous = self.area.take().ok_or("STALE_REF")?;
        let (area, _) = self.inspect()?;
        if !self
            .api
            .CompareElements(&previous, &area)
            .checked()?
            .as_bool()
        {
            return Err("STALE_REF");
        }
        let p: IUIAutomationScrollPattern = area
            .GetCurrentPatternAs(UIA_ScrollPatternId)
            .map_err(|_| UNSUPPORTED)?;
        require(p.CurrentVerticallyScrollable().checked()?.as_bool())?;
        self.w.check()?;
        self.area = Some(previous);
        Ok(p)
    }
    unsafe fn observe(&mut self) -> Result<Value> {
        let previous = self.area.take();
        let (area, view) = self.inspect()?;
        let same = match previous {
            Some(p) => self.api.CompareElements(&p, &area).checked()?.as_bool(),
            None => false,
        };
        if !same {
            self.revision += 1;
        }
        let mut lines = Vec::new();
        let masks = masks();
        for e in &view.labels {
            require(
                e.CurrentProcessId().checked()? == self.w.pid as i32
                    && matches!(
                        e.CurrentControlType().checked()?,
                        UIA_TextControlTypeId | UIA_ListItemControlTypeId
                    )
                    && !e.CurrentIsPassword().checked()?.as_bool()
                    && !e.CurrentIsOffscreen().checked()?.as_bool(),
            )?;
            let name = e.CurrentName().checked()?.to_string();
            require(!masks.iter().any(|v| name.contains(v)))?;
            if !name.is_empty() {
                lines.push(name.chars().take(200).collect::<String>());
            }
        }
        let mut node = json!({"id":self.id(),"role":"AXScrollArea"});
        if let Ok(p) = area.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId) {
            if p.CurrentVerticallyScrollable().checked()?.as_bool() {
                node["title"] = json!(format!(
                    "vertical scroll: {:.1}%",
                    p.CurrentVerticalScrollPercent().checked()?
                ));
            }
        }
        node["value"] = json!(lines.join("\n").chars().take(6000).collect::<String>());
        // Discard all text if the root/area or its safe structure changed during the read.
        let (again, live) = self.inspect()?;
        require(
            self.api.CompareElements(&area, &again).checked()?.as_bool()
                && live.labels.len() == view.labels.len(),
        )?;
        for (before, after) in view.labels.iter().zip(live.labels) {
            require(
                self.api
                    .CompareElements(before, &after)
                    .checked()?
                    .as_bool(),
            )?;
        }
        self.w.check()?;
        self.area = Some(area);
        Ok(json!({"tree":{"id":"window","role":"AXWindow","children":[node]}}))
    }
}
fn masks() -> Vec<String> {
    ["ONDRA_SECRET_NAMES", "ONDRA_SECRET_MASKS"]
        .iter()
        .flat_map(|key| {
            std::env::var(key)
                .unwrap_or_default()
                .split(',')
                .filter_map(|s| std::env::var(s.split('=').next()?).ok())
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>()
        })
        .collect()
}
