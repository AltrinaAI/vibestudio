//! Throwaway verification (delete after running): exercises the REAL
//! create_session → list_sessions path and confirms the turn-completion bell
//! hook stamps `bell_at`. Controls its own TMUX_TMPDIR so the code's tmux and
//! our manual bell injection provably share one isolated socket — no guessing.
//!
//!   cargo run -p skill-term --example bell_check
use std::process::Command;
use std::{thread, time::Duration};

fn tmux(args: &[&str]) -> String {
    let o = Command::new("tmux").args(args).output().expect("tmux");
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

fn main() {
    // Isolated socket dir, set before any tmux call (create_session inherits it).
    std::env::set_var("TMUX_TMPDIR", "/tmp/tisol_bellcheck");
    std::fs::create_dir_all("/tmp/tisol_bellcheck").ok();
    let _ = tmux(&["kill-server"]);
    thread::sleep(Duration::from_millis(300));

    let s = skill_term::create_session("shell", "/tmp", 80, 24, false, false, false, &[])
        .expect("create_session");
    let id = s.id.clone();
    println!("created id={id}  bell_at(return)={:?}", s.bell_at);
    assert_eq!(s.bell_at, "0", "fresh session should report bell_at=0");

    thread::sleep(Duration::from_millis(900)); // let the login shell settle
    println!("monitor-bell(window) = {:?}", tmux(&["show-options", "-w", "-t", &id, "-v", "monitor-bell"]));
    println!("alert-bell hook      = {:?}", tmux(&["show-hooks", "-t", &id]).lines().find(|l| l.contains("alert-bell")).unwrap_or("(none)"));
    println!("@ass_bell_at         = {:?}", tmux(&["display-message", "-p", "-t", &id, "#{@ass_bell_at}"]));

    let bell_at_of = |id: &str| -> String {
        skill_term::list_sessions().unwrap().into_iter()
            .find(|x| x.id == id).map(|x| x.bell_at).unwrap_or_else(|| "(gone)".into())
    };
    println!("list bell_at (pre)   = {:?}", bell_at_of(&id));

    // Ring the bell from the pane (same socket via inherited TMUX_TMPDIR).
    tmux(&["send-keys", "-t", &id, r#"printf "\007""#, "Enter"]);
    thread::sleep(Duration::from_millis(1300));
    let after_bell = bell_at_of(&id);
    println!("list bell_at (bell)  = {:?}  <-- EXPECT > 0", after_bell);

    // Plain output must NOT advance bell_at.
    tmux(&["send-keys", "-t", &id, "echo hello", "Enter"]);
    thread::sleep(Duration::from_millis(1100));
    let after_plain = bell_at_of(&id);
    println!("list bell_at (plain) = {:?}  <-- EXPECT == bell value", after_plain);

    // Second bell advances it again.
    tmux(&["send-keys", "-t", &id, r#"printf "\007""#, "Enter"]);
    thread::sleep(Duration::from_millis(1300));
    let after_bell2 = bell_at_of(&id);
    println!("list bell_at (bell2) = {:?}  <-- EXPECT > first bell", after_bell2);

    let pass = after_bell.parse::<u64>().unwrap_or(0) > 0
        && after_plain == after_bell
        && after_bell2.parse::<u64>().unwrap_or(0) > after_bell.parse::<u64>().unwrap_or(0);
    println!("\nRESULT: {}", if pass { "PASS ✓" } else { "FAIL ✗" });

    skill_term::kill_session(&id).ok();
    let _ = tmux(&["kill-server"]);
}
