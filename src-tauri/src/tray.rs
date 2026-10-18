// The system tray icon. Closing the window while downloads are running hides it here
// instead of quitting, so they carry on; a click on the icon (or "Show") brings the window back,
// and "Quit" stops everything for real. The menu's texts follow the page's language (`ui.rs`).
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Wry,
};

use crate::{
    queue,
    ui::{self, Language, UiLanguage},
};

/// The two entries of the menu, kept to change their text when the language changes. Managed
/// state, and also the proof that a tray exists: without one (a Linux desktop with no tray) hiding
/// the window would leave the app invisible, so the window just closes there.
pub struct Tray {
    show: MenuItem<Wry>,
    quit: MenuItem<Wry>,
}

pub fn create(app: &AppHandle, icon: Option<Image<'_>>) -> tauri::Result<()> {
    let (show_label, quit_label) = ui::tray_labels(app.state::<UiLanguage>().get());
    let show = MenuItem::with_id(app, "show", show_label, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", quit_label, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        // The left click shows the window; the menu is for the right one.
        .show_menu_on_left_click(false)
        .tooltip("AlbaRo Downloader")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_window(app),
            "quit" => quit_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_window(tray.app_handle());
            }
        });
    if let Some(icon) = icon {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    app.manage(Tray { show, quit });
    Ok(())
}

/// Whether the tray was created, so the window can safely hide into it.
pub fn exists(app: &AppHandle) -> bool {
    app.try_state::<Tray>().is_some()
}

pub fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // Each can fail harmlessly (already shown, not minimised): nothing to do about it.
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Quits for real: the downloads' processes are killed (their rows stay as they are, so the next
/// start resumes them) and the app exits.
fn quit_app(app: &AppHandle) {
    queue::shutdown(app);
    app.exit(0);
}

/// Puts the menu's texts in `language`.
pub fn relabel(app: &AppHandle, language: Language) {
    if let Some(tray) = app.try_state::<Tray>() {
        let (show, quit) = ui::tray_labels(language);
        // Errors only mean the menu is already gone.
        let _ = tray.show.set_text(show);
        let _ = tray.quit.set_text(quit);
    }
}
