// Deleting through a link. The app removes `<output>/.albaro-tmp/<id>` for a cancelled or
// failed download, and at start every such folder with no download behind it. If one of those
// folders were a symbolic link, or on Windows a junction (a directory link that needs no
// privilege), a naive recursive delete would empty whatever it points to. These tests make the
// links for real, inside a temporary folder of their own, with a "victim" next to them, and check
// that the victim survives every way the app deletes.
use std::{fs, path::Path};

use crate::{
    db::Db,
    queue::{clean_temp, sweep_orphans, Cleanup},
    test_util::TempDir,
};

/// A directory link at `link` pointing to `target`. A symbolic link on Unix; on Windows a junction
/// made with `mklink /J` (no privilege needed, which is why an attacker could make one too).
fn link_dir(link: &Path, target: &Path) {
    #[cfg(windows)]
    {
        let system = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let status = std::process::Command::new(format!("{system}\\System32\\cmd.exe"))
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(status.status.success(), "{status:?}");
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
}

/// `<root>/.albaro-tmp` and a victim folder with a file the tests must find again.
fn setup(name: &str) -> (TempDir, std::path::PathBuf, std::path::PathBuf) {
    let root = TempDir::new(name);
    let tmp = root.0.join(".albaro-tmp");
    fs::create_dir_all(&tmp).unwrap();
    let victim = root.0.join("victim");
    fs::create_dir_all(victim.join("deep")).unwrap();
    fs::write(victim.join("keep.txt"), "mine").unwrap();
    fs::write(victim.join("deep").join("keep2.txt"), "mine too").unwrap();
    (root, tmp, victim)
}

fn victim_intact(victim: &Path) -> bool {
    fs::read_to_string(victim.join("keep.txt")).is_ok_and(|t| t == "mine")
        && fs::read_to_string(victim.join("deep").join("keep2.txt")).is_ok_and(|t| t == "mine too")
}

#[test]
fn a_link_as_the_downloads_temporary_folder_is_removed_but_not_followed() {
    for delete in [true, false] {
        let cleanup = if delete {
            Cleanup::Delete
        } else {
            Cleanup::RemoveIfEmpty
        };
        let (_root, tmp, victim) = setup("link-as-id");
        let folder = tmp.join("7");
        link_dir(&folder, &victim);
        // Whether it succeeds or refuses is not the point; the victim is.
        let _ = clean_temp(&folder, 7, cleanup);
        assert!(victim_intact(&victim), "delete={delete}: followed the link");
    }
}

#[test]
fn a_link_inside_the_temporary_folder_is_removed_but_not_followed() {
    let (_root, tmp, victim) = setup("link-inside");
    let folder = tmp.join("8");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("movie.mp4.part"), "x").unwrap();
    link_dir(&folder.join("escape"), &victim);
    clean_temp(&folder, 8, Cleanup::Delete).unwrap();
    assert!(!folder.exists(), "the folder itself must go");
    assert!(victim_intact(&victim), "the delete followed the link");
}

#[test]
fn the_sweep_at_start_does_not_follow_a_link_either() {
    let (root, tmp, victim) = setup("link-sweep");
    // An id with no download behind it: swept. As a link, and with a link inside a real folder.
    link_dir(&tmp.join("9"), &victim);
    let real = tmp.join("10");
    fs::create_dir_all(&real).unwrap();
    link_dir(&real.join("escape"), &victim);
    let db = Db::open_in_memory().unwrap();
    let _ = sweep_orphans(&db, &root.0).unwrap();
    assert!(victim_intact(&victim), "the sweep followed a link");
}

#[test]
fn the_guard_refuses_a_path_that_is_not_a_downloads_folder() {
    let (root, _tmp, victim) = setup("guard");
    for wrong in [root.0.clone(), victim.clone(), root.0.join(".albaro-tmp")] {
        assert!(clean_temp(&wrong, 7, Cleanup::Delete).is_err(), "{wrong:?}");
    }
    assert!(victim_intact(&victim));
}
