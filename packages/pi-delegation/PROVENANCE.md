Extracted from pi-finn commit f78104a6f7ab34190c672333fe0cb3da60208df4.

The subagent entrypoint retains only the pi-security integration path. Legacy guards-dependent launching is excluded.

Versioned service contracts are copied locally; runtime discovery uses Pi events, not direct package imports.
