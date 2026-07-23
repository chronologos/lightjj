#!/usr/bin/env bash
# Creates a small deterministic jj repo for Bombadil UI fuzzing.
#
# Shape:
#   - ~15 commits, one branch point
#   - 1 divergent change (DivergencePanel reachability)
#   - 1 conflicted merge (ConflictQueue / MergePanel reachability)
#   - 1 clean mutable 2-parent merge (megamerge edit-parents target)
#   - README.md with a mermaid block (markdown preview toggle)
#   - multi-file commits (file stepping [ / ])
#   - 2 bookmarks (BookmarksPanel / BookmarkModal)
#   - a SECOND workspace (so the tab `◇N` workspace icon renders — the icon
#     only appears when a repo has ≥2 workspaces; see spec.ts / the
#     tab-workspace-menu design note)
#
# Usage:  ./fixture.sh /tmp/lightjj-fixture
# Re-runnable — nukes the target dir first. The fixture is cheap to recreate
# so run.sh does this fresh per run instead of `jj op restore` bookkeeping.

set -euo pipefail

REPO="${1:?usage: fixture.sh <target-dir>}"
rm -rf "$REPO" "$REPO-ws2"
mkdir -p "$REPO"
cd "$REPO"

# Author identity — avoid leaking the caller's global jj config into the
# fixture (signing is disabled below). NOT pinning JJ_RANDOMNESS_SEED: a
# fixed seed makes every `jj commit`'s fresh working-copy change get the
# SAME change_id → accidental N-way divergence on commit 2. Structure
# determinism (graph shape, conflict, one intentional divergence) is all
# the UI fuzzer needs; specific IDs don't matter since spec.ts queries by
# CSS class/attr.
export JJ_USER="Fixture Bot"
export JJ_EMAIL="fixture@lightjj.test"

jj git init .
jj config set --repo signing.behavior drop

write() { printf '%s\n' "$2" > "$1"; }

# --- trunk: 5 linear commits ---------------------------------------------
write README.md '# Fixture repo

Demo content for UI fuzzing.

```mermaid
graph TD
  A[root] --> B[trunk]
  B --> C[feature]
```
'
write main.go 'package main

func main() { println("v0") }
'
jj commit -m "init: scaffold"

write main.go 'package main

import "fmt"

func main() { fmt.Println("v1") }
'
write util.go 'package main

func helper() int { return 1 }
'
jj commit -m "feat: add helper"

write util.go 'package main

func helper() int { return 2 }
func other() int { return 10 }
'
jj commit -m "feat: extend util"

write main.go 'package main

import "fmt"

func main() {
	fmt.Println("v2")
	fmt.Println(helper())
}
'
jj commit -m "refactor: call helper from main"

write README.md '# Fixture repo

Updated docs.

```mermaid
graph TD
  A[root] --> B[trunk]
  B --> C[feature]
  B --> D[side]
```
'
jj commit -m "docs: update diagram"
jj bookmark create trunk -r @-

# --- side branch: will conflict with feature branch on util.go -----------
jj new trunk -m "side: tweak helper return"
write util.go 'package main

func helper() int { return 99 }
func other() int { return 10 }
'
jj bookmark create side -r @

# --- feature branch: same line, different value --------------------------
jj new trunk -m "feature: tweak helper differently"
write util.go 'package main

func helper() int { return 42 }
func other() int { return 10 }
'
write feature.go 'package main

func featureThing() {}
'
jj bookmark create feature -r @

# --- merge: produces a conflict in util.go -------------------------------
jj new side feature -m "merge: side + feature (conflicted)"

# --- divergent change ----------------------------------------------------
# Rewrite the same change from a past op-log point. When the two op heads
# merge, the change_id has two commit_ids → divergent. Using trunk~ keeps
# the divergence away from the branch point so the graph stays readable.
jj new trunk -m "will diverge"
write notes.txt 'version A'
jj describe -m "diverge: version A"
OP_BEFORE=$(jj op log --no-graph -T 'id' -n 1)
jj describe -m "diverge: version A (amended)"
# Rewrite at the pre-amend op — creates a second op head. The next jj
# command reconciles the two heads and surfaces the divergence. `-r @`
# is valid inside --at-op because @ resolves against that op's view.
jj --at-op "$OP_BEFORE" describe -r @ -m "diverge: version B"

# --- clean 2-parent merge: a mutable megamerge target --------------------
# Two independent commits off trunk touching DIFFERENT files (no overlap →
# clean auto-merge, unlike the side+feature conflict above). The resulting
# merge is mutable and sits near the top of the graph — an ideal target for
# megamerge mode (M): its parent set can be meaningfully edited (add/remove a
# parent) without first resolving a conflict. Bookmarks mm-a/mm-b give the
# merge stable parents (and snapshot each working copy before we branch away).
jj new trunk -m "mm-a: add one.txt"
write one.txt 'one'
jj bookmark create mm-a -r @
jj new trunk -m "mm-b: add two.txt"
write two.txt 'two'
jj bookmark create mm-b -r @
jj new mm-a mm-b -m "megamerge target: clean 2-parent merge"

# --- second workspace ----------------------------------------------------
# The tab `◇N` workspace icon renders only when a repo has ≥2 workspaces, so
# the fixture (served as the `default` workspace via -R) needs a sibling. Rooted
# at trunk with an explicit --name for determinism; the server never opens it as
# a tab (run.sh mounts only the default workspace), it just needs to exist in the
# workspace_store index so /tab/0/api/workspaces reports a count of 2.
jj workspace add --name ws2 -r trunk "$REPO-ws2"

# --- park @ on an empty commit off trunk ---------------------------------
# Leaves the merge + divergence intact while giving j/k somewhere harmless
# to start. `jj new` also snapshots the working copy, flushing any pending
# fsmonitor state before the server starts.
jj new trunk

echo "fixture ready at $REPO"
jj log -r 'all()' --no-graph -T 'change_id.short() ++ " " ++ description.first_line() ++ "\n"'
