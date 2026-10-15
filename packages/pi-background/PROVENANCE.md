Extracted from pi-finn commit f78104a6f7ab34190c672333fe0cb3da60208df4.

The native Bash extension retains the process lifecycle and bounded-output implementation.
Shared process code lives in pi-runtime; versioned interfaces live in pi-contracts. The old
sandbox transport and forwarding modules were removed during the native package migration.
