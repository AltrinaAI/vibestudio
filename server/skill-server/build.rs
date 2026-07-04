// include_dir! can't register the embedded dist files with cargo, so without
// this an embed-ui rebuild after `npm run build` silently ships the old SPA.
fn main() {
    if std::env::var_os("CARGO_FEATURE_EMBED_UI").is_some() {
        println!("cargo:rerun-if-changed=../../dist");
    }
}
