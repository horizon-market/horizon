use std::{env, fs, path::PathBuf};

use anyhow::Result;
use substreams_ethereum::Abigen;

/// Bindings for the five contracts whose events the module extracts. The ABI files are copies of
/// `subgraph/abis/`, so the Subgraph and the stream decode the same event signatures.
///
/// Only the event entries are handed to Abigen: functions are never called from the module, and a
/// function named `result()` (BinaryMarket) would generate a `struct Result` that shadows the
/// standard one inside the bindings and breaks the build.
fn main() -> Result<()> {
    let out = PathBuf::from(env::var("OUT_DIR")?).join("abi-events");
    fs::create_dir_all(&out)?;
    for (name, file) in [
        ("registry", "abi/MarketRegistry.json"),
        ("router", "abi/HorizonSwapVM.json"),
        ("executor", "abi/RouteExecutor.json"),
        ("aqua", "abi/Aqua.json"),
        ("market", "abi/BinaryMarket.json"),
    ] {
        println!("cargo:rerun-if-changed={file}");
        let abi: serde_json::Value = serde_json::from_str(&fs::read_to_string(file)?)?;
        let entries = abi.as_array().map(|entries| entries.iter().filter(|entry| entry["type"] == "event").cloned().collect::<Vec<_>>()).unwrap_or_default();
        let filtered = out.join(format!("{name}.json"));
        fs::write(&filtered, serde_json::to_string(&entries)?)?;
        Abigen::new(name, filtered.to_str().expect("utf-8 path"))?.generate()?.write_to_file(format!("src/abi/{name}.rs"))?;
    }
    Ok(())
}
