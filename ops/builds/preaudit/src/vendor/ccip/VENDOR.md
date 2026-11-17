# Vendored Chainlink CCIP sources

- Package: `@chainlink/contracts-ccip`
- Version: 2.0.0
- Published: 2026-06-18
- Integrity: `sha512-P0KvQtZSYC1LevMSS16jOOSsqZG4g0n/MJdcWGmE0Z5U01NVYd1MnTQJOBPsbu1NWR79DBXPXLvyr9tR5y+tiw==`

Files (copied from `package/contracts/`):

- `libraries/Client.sol` -> `Client.sol`
- `interfaces/IRouterClient.sol` -> `IRouterClient.sol`
- `interfaces/IAny2EVMMessageReceiver.sol` -> `IAny2EVMMessageReceiver.sol`

Only change: in `IRouterClient.sol` and `IAny2EVMMessageReceiver.sol` the import
`"../libraries/Client.sol"` became `"./Client.sol"`. Any other change is a bug.
