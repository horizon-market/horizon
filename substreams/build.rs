use anyhow::Result;
use substreams_ethereum::Abigen;

/// Bindings for the five contracts whose events the module extracts. The ABI files are copies of
/// `subgraph/abis/`, so the Subgraph and the stream decode the same event signatures.
fn main() -> Result<()> {
    for (name, file) in [
        ("registry", "abi/MarketRegistry.json"),
        ("router", "abi/HorizonSwapVM.json"),
        ("executor", "abi/RouteExecutor.json"),
        ("aqua", "abi/Aqua.json"),
        ("market", "abi/BinaryMarket.json"),
    ] {
        Abigen::new(name, file)?.generate()?.write_to_file(format!("src/abi/{name}.rs"))?;
    }
    Ok(())
}
