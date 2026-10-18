// The few texts Rust itself shows: the notification that says the queue is done and
// the tray's menu. The page owns the language (it is in its localStorage), so it tells Rust at
// start and on every change (`set_ui_language`); Rust keeps the last one it heard. Only Spanish and
// English, like the page. Everything else the user reads is in the page's i18n files.
use std::sync::{Mutex, PoisonError};

/// The language of the page. English until the page says otherwise (it does so at start).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Language {
    Es,
    #[default]
    En,
}

impl Language {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "es" => Some(Self::Es),
            "en" => Some(Self::En),
            _ => None,
        }
    }
}

/// The language last reported by the page (managed state).
#[derive(Default)]
pub struct UiLanguage(Mutex<Language>);

impl UiLanguage {
    pub fn get(&self) -> Language {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn set(&self, language: Language) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = language;
    }
}

/// What the queue did since it was last idle: how many downloads finished and failed, and the
/// title of the one that finished when it was only one.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Summary {
    pub finished: u32,
    pub failed: u32,
    /// Only used when exactly one download finished and none failed.
    pub only_title: Option<String>,
}

/// The notification for a queue that went quiet: a title and a body. `None` if nothing finished or
/// failed (cancelled and paused downloads are not news).
pub fn idle_message(language: Language, summary: &Summary) -> Option<(String, String)> {
    let Summary {
        finished,
        failed,
        only_title,
    } = summary;
    let (finished, failed) = (*finished, *failed);
    let es = language == Language::Es;
    let plural = |n: u32, one: &str, many: &str| {
        if n == 1 {
            format!("{n} {one}")
        } else {
            format!("{n} {many}")
        }
    };
    match (finished, failed) {
        (0, 0) => None,
        (1, 0) => Some((
            if es {
                "Descarga terminada"
            } else {
                "Download finished"
            }
            .into(),
            // From a site: short, and not markup for a notification server.
            only_title
                .as_deref()
                .map(crate::text::for_notification)
                .unwrap_or_default(),
        )),
        (f, 0) => Some((
            if es {
                plural(f, "descarga terminada", "descargas terminadas")
            } else {
                plural(f, "download finished", "downloads finished")
            },
            String::new(),
        )),
        (0, e) => Some((
            if es {
                plural(e, "descarga fallida", "descargas fallidas")
            } else {
                plural(e, "download failed", "downloads failed")
            },
            if es {
                "Abre la app para ver el motivo."
            } else {
                "Open the app to see why."
            }
            .into(),
        )),
        (f, e) => Some((
            if es {
                plural(f, "descarga terminada", "descargas terminadas")
            } else {
                plural(f, "download finished", "downloads finished")
            },
            if es {
                plural(e, "con error", "con error")
            } else {
                plural(e, "failed", "failed")
            },
        )),
    }
}

/// The tray menu's two entries: show the window, quit.
pub fn tray_labels(language: Language) -> (&'static str, &'static str) {
    match language {
        Language::Es => ("Mostrar AlbaRo Downloader", "Salir"),
        Language::En => ("Show AlbaRo Downloader", "Quit"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(finished: u32, failed: u32, title: Option<&str>) -> Summary {
        Summary {
            finished,
            failed,
            only_title: title.map(String::from),
        }
    }

    #[test]
    fn languages_are_the_two_the_page_has() {
        assert_eq!(Language::parse("es"), Some(Language::Es));
        assert_eq!(Language::parse("en"), Some(Language::En));
        for bad in ["", "ES", "fr", "es-ES", "system"] {
            assert_eq!(Language::parse(bad), None, "{bad}");
        }
        // English until told otherwise; the last word wins.
        let ui = UiLanguage::default();
        assert_eq!(ui.get(), Language::En);
        ui.set(Language::Es);
        assert_eq!(ui.get(), Language::Es);
    }

    #[test]
    fn nothing_finished_or_failed_is_no_news() {
        assert_eq!(idle_message(Language::En, &summary(0, 0, None)), None);
    }

    #[test]
    fn one_download_names_itself() {
        assert_eq!(
            idle_message(Language::En, &summary(1, 0, Some("Me at the zoo"))),
            Some(("Download finished".into(), "Me at the zoo".into()))
        );
        assert_eq!(
            idle_message(Language::Es, &summary(1, 0, Some("Me at the zoo"))),
            Some(("Descarga terminada".into(), "Me at the zoo".into()))
        );
    }

    #[test]
    fn many_are_counted_with_the_right_plural() {
        assert_eq!(
            idle_message(Language::Es, &summary(23, 0, None)),
            Some(("23 descargas terminadas".into(), String::new()))
        );
        assert_eq!(
            idle_message(Language::En, &summary(2, 0, None)).unwrap().0,
            "2 downloads finished"
        );
        assert_eq!(
            idle_message(Language::En, &summary(0, 1, None)).unwrap().0,
            "1 download failed"
        );
        assert_eq!(
            idle_message(Language::Es, &summary(0, 3, None)).unwrap().0,
            "3 descargas fallidas"
        );
    }

    #[test]
    fn failures_are_mentioned_beside_the_finished_ones() {
        assert_eq!(
            idle_message(Language::En, &summary(5, 2, None)),
            Some(("5 downloads finished".into(), "2 failed".into()))
        );
        assert_eq!(
            idle_message(Language::Es, &summary(1, 1, Some("x"))),
            Some(("1 descarga terminada".into(), "1 con error".into()))
        );
    }

    #[test]
    fn the_tray_menu_follows_the_language() {
        assert_eq!(
            tray_labels(Language::En),
            ("Show AlbaRo Downloader", "Quit")
        );
        assert_eq!(
            tray_labels(Language::Es),
            ("Mostrar AlbaRo Downloader", "Salir")
        );
    }
}
