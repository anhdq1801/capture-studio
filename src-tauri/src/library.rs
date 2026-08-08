use crate::models::MediaItem;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// In-memory + on-disk index of every capture.
pub struct Library {
    pub dir: PathBuf,
    pub items: Vec<MediaItem>,
}

impl Library {
    fn index_path(&self) -> PathBuf {
        self.dir.join("library.json")
    }

    pub fn load() -> Self {
        let dir = default_library_dir();
        let _ = fs::create_dir_all(&dir);
        let index = dir.join("library.json");
        let items = fs::read_to_string(&index)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<MediaItem>>(&s).ok())
            .unwrap_or_default();
        // Drop entries whose file has been deleted on disk. Drafts are captures the user
        // never saved — a crash or force-quit can strand them, so clear them out here too
        // rather than letting orphaned files accumulate invisibly.
        let mut items: Vec<MediaItem> = items
            .into_iter()
            .filter(|it| dir.join(&it.file_name).exists())
            .collect();
        for stale in items.iter().filter(|it| it.draft) {
            let _ = fs::remove_file(dir.join(&stale.file_name));
        }
        items.retain(|it| !it.draft);
        let lib = Library { dir, items };
        lib.save();
        lib
    }

    pub fn save(&self) {
        if let Ok(json) = serde_json::to_string_pretty(&self.items) {
            let _ = fs::write(self.index_path(), json);
        }
    }

    pub fn add(&mut self, item: MediaItem) {
        self.items.retain(|it| it.id != item.id);
        self.items.push(item);
        self.save();
    }

    pub fn get(&self, id: &str) -> Option<MediaItem> {
        self.items.iter().find(|it| it.id == id).cloned()
    }

    pub fn update<F: FnOnce(&mut MediaItem)>(&mut self, id: &str, f: F) -> Option<MediaItem> {
        let found = self.items.iter_mut().find(|it| it.id == id);
        if let Some(item) = found {
            f(item);
            let cloned = item.clone();
            self.save();
            Some(cloned)
        } else {
            None
        }
    }

    pub fn remove(&mut self, id: &str) -> bool {
        if let Some(pos) = self.items.iter().position(|it| it.id == id) {
            let item = self.items.remove(pos);
            let _ = fs::remove_file(self.dir.join(&item.file_name));
            // A recording's poster frame is a separate file and would otherwise be left
            // behind, invisible to the library but still taking up space.
            if let Some(thumb) = &item.thumb_name {
                let _ = fs::remove_file(self.dir.join(thumb));
            }
            self.save();
            true
        } else {
            false
        }
    }

    pub fn path_of(&self, file_name: &str) -> PathBuf {
        self.dir.join(file_name)
    }

    /// Newest first. Drafts are excluded — they only exist for the editor to work on and
    /// have not been saved into the library yet.
    pub fn sorted(&self) -> Vec<MediaItem> {
        let mut v: Vec<MediaItem> = self.items.iter().filter(|it| !it.draft).cloned().collect();
        v.reverse();
        v
    }
}

pub fn default_library_dir() -> PathBuf {
    let base = dirs::picture_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("CaptureStudio")
}

pub fn file_size(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

pub type LibraryState = Mutex<Library>;
