//! Horizon's own contract events, one message per block, for the live layer.
//!
//! Three modules. `map_registry_events` extracts `MarketCreated` alone; `store_markets` remembers
//! every market address it names; `map_horizon_events` extracts everything, and reads that store to
//! keep only the `CollateralChanged` / `MarketResolved` logs that a Horizon market emitted — the
//! stream's equivalent of the Subgraph's per-market data source template. Nothing is decoded that
//! the consumer needs an RPC for: `Shipped` carries the raw strategy bytes, and the consumer asks
//! the router to decode them, exactly as the Subgraph mapping does.
//!
//! Addresses come in as module params (`registry=0x…&router=0x…&executor=0x…&aqua=0x…`), written
//! into the manifest from `deployments/sepolia.json` by `scripts/substreams-pack.ts`.
mod abi;
mod pb;

use pb::horizon::v1::{self as horizon, horizon_event::Data, HorizonEvent, HorizonEvents};
use substreams::store::{StoreGet, StoreGetString, StoreSetIfNotExists, StoreSetIfNotExistsString};
use substreams_ethereum::pb::eth::v2 as eth;
use substreams_ethereum::Event;

substreams_ethereum::init!();

struct Addresses {
    registry: Vec<u8>,
    router: Vec<u8>,
    executor: Vec<u8>,
    aqua: Vec<u8>,
}

fn parse_params(params: &str) -> Result<Addresses, substreams::errors::Error> {
    let mut found = Addresses { registry: vec![], router: vec![], executor: vec![], aqua: vec![] };
    for pair in params.split('&') {
        let Some((key, value)) = pair.split_once('=') else { continue };
        let bytes = hex::decode(value.trim_start_matches("0x"))
            .map_err(|_| substreams::errors::Error::msg(format!("param {key} is not hex")))?;
        if bytes.len() != 20 {
            return Err(substreams::errors::Error::msg(format!("param {key} is not an address")));
        }
        match key {
            "registry" => found.registry = bytes,
            "router" => found.router = bytes,
            "executor" => found.executor = bytes,
            "aqua" => found.aqua = bytes,
            _ => {}
        }
    }
    for (name, value) in [("registry", &found.registry), ("router", &found.router), ("executor", &found.executor), ("aqua", &found.aqua)] {
        if value.is_empty() {
            return Err(substreams::errors::Error::msg(format!("missing param {name}")));
        }
    }
    Ok(found)
}

fn hex0x(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

/// Every numeric ABI type formats as its decimal value, whatever Rust type the bindings chose for it.
fn decimal<T: ToString>(value: &T) -> String {
    value.to_string()
}

fn u64_of<T: ToString>(value: &T) -> u64 {
    value.to_string().parse::<u64>().unwrap_or(0)
}

fn envelope(kind: &str, blk: &eth::Block, log: &substreams_ethereum::block_view::LogView, data: Data) -> HorizonEvent {
    HorizonEvent {
        kind: kind.to_string(),
        contract: hex0x(&log.log.address),
        block_number: blk.number,
        block_hash: hex0x(&blk.hash),
        block_timestamp: blk.timestamp_seconds(),
        tx_hash: hex0x(&log.receipt.transaction.hash),
        // The log's position in the block, which is what every other Horizon identifier uses.
        log_index: log.log.block_index,
        tx_index: log.receipt.transaction.index,
        data: Some(data),
    }
}

fn market_created(blk: &eth::Block, log: &substreams_ethereum::block_view::LogView) -> Option<HorizonEvent> {
    let event = abi::registry::events::MarketCreated::match_and_decode(log)?;
    Some(envelope("MARKET_CREATED", blk, log, Data::MarketCreated(horizon::MarketCreated {
        creation_id: hex0x(&event.creation_id),
        market: hex0x(&event.market),
        resolver: hex0x(&event.resolver),
        yes_token: hex0x(&event.yes_token),
        no_token: hex0x(&event.no_token),
        close_at: u64_of(&event.close_at),
        question: event.question,
        rules: event.rules,
        evidence_source: event.evidence_source,
    })))
}

/// `MarketCreated` alone, so the market store below has an input that changes only when a market
/// is created and the full extraction can read it in the same block.
#[substreams::handlers::map]
fn map_registry_events(params: String, blk: eth::Block) -> Result<HorizonEvents, substreams::errors::Error> {
    let addresses = parse_params(&params)?;
    let events = blk
        .logs()
        .filter(|log| log.log.address == addresses.registry)
        .filter_map(|log| market_created(&blk, &log))
        .collect();
    Ok(HorizonEvents { events })
}

/// Market addresses keyed `market:0x…`. Set-if-not-exists: a market is created once.
#[substreams::handlers::store]
fn store_markets(events: HorizonEvents, store: StoreSetIfNotExistsString) {
    for event in events.events {
        if let Some(Data::MarketCreated(created)) = event.data {
            store.set_if_not_exists(event.log_index as u64, format!("market:{}", created.market), &created.market);
        }
    }
}

#[substreams::handlers::map]
fn map_horizon_events(params: String, blk: eth::Block, markets: StoreGetString) -> Result<HorizonEvents, substreams::errors::Error> {
    let addresses = parse_params(&params)?;
    let mut events = Vec::new();
    for log in blk.logs() {
        let address = &log.log.address;
        if *address == addresses.registry {
            if let Some(event) = market_created(&blk, &log) {
                events.push(event);
            }
        } else if *address == addresses.router {
            if let Some(filled) = abi::router::events::CurveFilled::match_and_decode(&log) {
                events.push(envelope("CURVE_FILLED", &blk, &log, Data::CurveFilled(horizon::CurveFilled {
                    order_hash: hex0x(&filled.order_hash),
                    market: hex0x(&filled.market),
                    maker: hex0x(&filled.maker),
                    shares: decimal(&filled.shares),
                    usdc_amount: decimal(&filled.usdc_amount),
                    total_filled: decimal(&filled.total_filled),
                })));
            } else if let Some(admitted) = abi::router::events::StrategyAdmitted::match_and_decode(&log) {
                events.push(envelope("STRATEGY_ADMITTED", &blk, &log, Data::StrategyAdmitted(horizon::StrategyAdmitted {
                    order_hash: hex0x(&admitted.order_hash),
                    market: hex0x(&admitted.market),
                    maker: hex0x(&admitted.maker),
                    token: hex0x(&admitted.token),
                    commitment: decimal(&admitted.commitment),
                    committed_before: decimal(&admitted.committed_before),
                    spendable: decimal(&admitted.spendable),
                })));
            }
        } else if *address == addresses.executor {
            if let Some(route) = abi::executor::events::RouteExecuted::match_and_decode(&log) {
                events.push(envelope("ROUTE_EXECUTED", &blk, &log, Data::RouteExecuted(horizon::RouteExecuted {
                    market: hex0x(&route.market),
                    taker: hex0x(&route.taker),
                    recipient: hex0x(&route.recipient),
                    is_yes: route.is_yes,
                    is_buy: route.is_buy,
                    shares: decimal(&route.shares),
                    usdc_amount: decimal(&route.usdc_amount),
                    fills: decimal(&route.fills),
                })));
            }
        } else if *address == addresses.aqua {
            // Aqua is shared by many applications; only publications addressed to the Horizon
            // router are Horizon liquidity.
            if let Some(shipped) = abi::aqua::events::Shipped::match_and_decode(&log) {
                if shipped.app == addresses.router {
                    events.push(envelope("SHIPPED", &blk, &log, Data::Shipped(horizon::Shipped {
                        maker: hex0x(&shipped.maker),
                        app: hex0x(&shipped.app),
                        strategy_hash: hex0x(&shipped.strategy_hash),
                        strategy: hex0x(&shipped.strategy),
                    })));
                }
            } else if let Some(docked) = abi::aqua::events::Docked::match_and_decode(&log) {
                if docked.app == addresses.router {
                    events.push(envelope("DOCKED", &blk, &log, Data::Docked(horizon::Docked {
                        maker: hex0x(&docked.maker),
                        app: hex0x(&docked.app),
                        strategy_hash: hex0x(&docked.strategy_hash),
                    })));
                }
            }
        } else {
            // A market contract is only known once the registry announced it; every other
            // emitter of these two signatures is some unrelated contract.
            let market = hex0x(address);
            if markets.get_last(format!("market:{market}")).is_none() {
                continue;
            }
            if let Some(changed) = abi::market::events::CollateralChanged::match_and_decode(&log) {
                events.push(envelope("COLLATERAL_CHANGED", &blk, &log, Data::CollateralChanged(horizon::CollateralChanged {
                    market: market.clone(),
                    collateral: decimal(&changed.collateral),
                })));
            } else if let Some(resolved) = abi::market::events::MarketResolved::match_and_decode(&log) {
                events.push(envelope("MARKET_RESOLVED", &blk, &log, Data::MarketResolved(horizon::MarketResolved {
                    market: market.clone(),
                    result: u64_of(&resolved.result) as u32,
                    resolver: hex0x(&resolved.resolver),
                    evidence: resolved.evidence,
                })));
            }
        }
    }
    Ok(HorizonEvents { events })
}
