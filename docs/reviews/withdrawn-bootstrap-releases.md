# Withdrawn bootstrap catalog entries

The initial catalog entries `expenses.core@0.6.0`, `parties.core@0.8.0` and `catalog.core@0.6.0` were withdrawn before the initial npm SDK publication. Their package dependencies targeted individually published core packages; the accepted distribution model publishes one shared SDK instead. Advertising those entries would allow an installation plan whose npm dependencies could never be satisfied by the intended release set.

Their committed source artifacts remain unchanged in `registry/releases` for historical inspection. Current catalog entries are `expenses.core@0.6.1`, `parties.core@0.8.1` and `catalog.core@0.6.1`, which depend on `@flowdular/sdk@0.1.0`. The catalog generator retains the active release history from this index and does not reintroduce the withdrawn bootstrap entries.
