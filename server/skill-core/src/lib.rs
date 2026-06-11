// Transport-agnostic core: skill filesystem ops + discovery, no GUI/Tauri deps.
// Reused by both the Tauri desktop app and the headless skill-server.
pub mod agents;
pub mod commitmsg;
pub mod discover;
pub mod engine;
pub mod filetypes;
pub mod github;
pub mod gitops;
pub mod gpu;
pub mod mining;
pub mod pathsafe;
pub mod process;
pub mod remotesync;
pub mod secrets;
pub mod skill;
pub mod sync;
