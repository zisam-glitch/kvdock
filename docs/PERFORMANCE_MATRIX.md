# KVDock Multi-Adapter Performance Matrix

*Benchmark executed on 2026-11-03T01:50:03.534Z across 1000 ops per payload size.*

| Storage Adapter | 1KB Write (ops/s) | 1KB Read (ops/s) | 10KB Write (ops/s) | 10KB Read (ops/s) | 100KB Write (ops/s) | 100KB Read (ops/s) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **MemoryAdapter** | 588,120 | 936,841 | 125,324 | 145,597 | 13,307 | 19,995 |
| **SQLiteAdapter (:memory:)** | 296,633 | 460,017 | 63,204 | 134,475 | 12,783 | 19,493 |
| **LocalStorageAdapter** | 803,428 | 571,415 | 125,910 | 74,422 | 11,114 | 8,054 |
| **DenoKvAdapter (Mock)** | 866,927 | 1,000,417 | 219,839 | 177,780 | 15,117 | 19,994 |
| **MongoDBAdapter (Mock)** | 1,098,147 | 1,047,441 | 191,484 | 237,565 | 14,245 | 24,090 |
| **FsAdapter (disk)** | 4,611 | 34,309 | 2,839 | 19,288 | ~ | ~ |
