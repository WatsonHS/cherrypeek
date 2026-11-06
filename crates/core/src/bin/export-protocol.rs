use commitscope_core::{client_message_schema, core_ready_schema, server_message_schema};
use serde_json::{Map, Value};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let schema = match args.next().as_deref().and_then(|arg| arg.to_str()) {
        None => serde_json::to_value(core_ready_schema())?,
        Some("--all") if args.next().is_none() => {
            let mut schemas = Map::new();
            schemas.insert(
                "core-ready".into(),
                serde_json::to_value(core_ready_schema())?,
            );
            schemas.insert(
                "client-message".into(),
                serde_json::to_value(client_message_schema())?,
            );
            schemas.insert(
                "server-message".into(),
                serde_json::to_value(server_message_schema())?,
            );
            Value::Object(schemas)
        }
        _ => return Err("usage: export-protocol [--all]".into()),
    };
    serde_json::to_writer_pretty(std::io::stdout().lock(), &schema)?;
    println!();
    Ok(())
}
