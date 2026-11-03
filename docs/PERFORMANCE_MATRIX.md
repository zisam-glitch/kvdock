# KVDock Multi-Adapter Performance Matrix

*Benchmark executed on 2026-11-03T00:04:42.714Z across 1000 ops per payload size.*

| Storage Adapter | 1KB Write (ops/s) | 1KB Read (ops/s) | 10KB Write (ops/s) | 10KB Read (ops/s) | 100KB Write (ops/s) | 100KB Read (ops/s) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **MemoryAdapter** | 600,360 | 937,866 | 94,130 | 116,306 | 8,534 | 16,678 |
| **SQLiteAdapter (:memory:)** | 293,284 | 496,925 | 57,122 | 146,031 | 11,840 | 17,595 |
| **LocalStorageAdapter** | 717,103 | 565,185 | 126,027 | 74,901 | 9,322 | 8,274 |
| **DenoKvAdapter (Mock)** | 905,729 | 1,026,518 | 165,611 | 210,532 | 15,654 | 19,874 |
| **MongoDBAdapter (Mock)** | 1,121,758 | 1,084,011 | 221,805 | 182,026 | 13,957 | 22,698 |
| **FsAdapter (disk)** | 4,426 | 33,848 | 2,976 | 18,872 | ~ | ~ |
