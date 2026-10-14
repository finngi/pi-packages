Goal and session-handling code originated in pi-finn commit f78104a6f7ab34190c672333fe0cb3da60208df4.

The package now uses independent goal evaluation, fixed acceptance criteria and worker request-budget admission. Goal ownership and response waits use Pi's extension events; shared accounting is supplied by pi-runtime and pi-contracts. Model requests and credentials use Pi's public ModelRegistry.
