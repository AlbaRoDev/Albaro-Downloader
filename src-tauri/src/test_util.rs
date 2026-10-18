// Helpers shared by the tests of several modules.
use std::{fs, path::PathBuf};

/// A folder of its own, deleted on drop. `Drop` also runs when a test panics (the panic
/// unwinds the stack), so the folder is removed even when an assertion fails.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("albaro-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
