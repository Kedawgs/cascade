# Vendored Chainlink CCIP sources (tests only)

- Package: `@chainlink/contracts-ccip`
- Version: 2.0.0
- Published: 2026-06-18
- Integrity: `sha512-P0KvQtZSYC1LevMSS16jOOSsqZG4g0n/MJdcWGmE0Z5U01NVYd1MnTQJOBPsbu1NWR79DBXPXLvyr9tR5y+tiw==`

Files (copied from `package/contracts/`):

- `libraries/MessageV1Codec.sol` -> `MessageV1Codec.sol`
  (sha256 `6a0f516db26a97c57fa2d545367c9ff3903a3f1ee45432e241a55a39386d0356`)

No changes: the file is byte-for-byte the package's (it has no imports). Any change is a bug.
The fork harness (`test/fork/ForkBase.sol`) uses it to encode the `MessageV1` that the real
`OffRamp 2.0.0` executes; nothing under `src/` imports it.
