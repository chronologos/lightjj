package jj

import "strings"

// DivergenceEntry is one commit in the divergence classification dataset.
// Emitted for every mutable divergent commit AND their descendants (the
// descendants may be non-divergent — they're the visible-head pins like
// automated warm-merges that keep a stale stack alive). See docs/jj-divergence.md.
//
// Separate from Commit: we need ParentChangeIds + WCReachable + IsWorkingCopy
// for classification, but Commit is the hot-path struct for LogGraph and
// shouldn't grow fields that only the divergence panel uses. CommitterTs
// deliberately absent — structurally inverted for --at-op (stamps now()), see
// docs §"Failed heuristics". Don't add it back.
type DivergenceEntry struct {
	ChangeId        string   `json:"change_id"`
	CommitId        string   `json:"commit_id"`
	Divergent       bool     `json:"divergent"`
	ParentCommitIds []string `json:"parent_commit_ids"`
	ParentChangeIds []string `json:"parent_change_ids"`
	WCReachable     bool     `json:"wc_reachable"` // contained_in("::working_copies()") — see doc for tautology guard
	Bookmarks       []string `json:"bookmarks"`
	Description     string   `json:"description"`
	Empty           bool     `json:"empty"`           // for descendant confirm: empty descendants abandon silently, non-empty prompt
	IsWorkingCopy   bool     `json:"is_working_copy"` // @ IS this commit — tautology guard: if true anywhere in group, strip liveVersion hint
}

// divergenceTemplate is the tested template from docs/jj-divergence.md.
// 10 fields, \x1F-separated, \n records. Order MUST match ParseDivergence.
//
// local_bookmarks.map(|b| b.name()) strips @origin tracking and * ahead-marker.
// Bookmarks join on \x1E (sub-field sep) — commas are valid in git refs so
// join(",") would split `fix,bug` into phantoms. Parent IDs stay comma-joined
// (hex strings can't contain commas). .short() to match LogGraph.
const divergenceTemplate = `change_id.short() ++ "\x1F" ++ ` +
	`commit_id.short() ++ "\x1F" ++ ` +
	`if(divergent, "1", "") ++ "\x1F" ++ ` +
	`parents.map(|p| p.commit_id().short()).join(",") ++ "\x1F" ++ ` +
	`parents.map(|p| p.change_id().short()).join(",") ++ "\x1F" ++ ` +
	`if(self.contained_in("::working_copies()"), "1", "") ++ "\x1F" ++ ` +
	`local_bookmarks.map(|b| b.name()).join("\x1E") ++ "\x1F" ++ ` +
	`description.first_line() ++ "\x1F" ++ ` +
	`if(empty, "1", "") ++ "\x1F" ++ ` +
	`if(current_working_copy, "1", "") ++ "\n"`

// Divergence returns args for the classification log call. Revset captures
// mutable divergent commits and their descendants (provably also mutable:
// immutable = ::immutable_heads(), so a mutable commit's descendants can't
// be ancestors of immutable heads). Descendants are the collateral (bookmark
// conflicts live on the divergent commits themselves, pinning children live
// above them).
//
// --no-graph: we build the graph client-side from parent_ids; jj's ASCII
// gutter would just get in the way.
func Divergence() CommandArgs {
	return []string{
		"log",
		"-r", "(divergent() & mutable())::",
		"--no-graph",
		"--color", "never",
		"--ignore-working-copy",
		"-T", divergenceTemplate,
	}
}

// ParseDivergence parses Divergence() output. Order is jj's index emission
// order — DO NOT sort. This is what /N offsets map to (GlobalCommitPosition
// descending per lib/src/index.rs:217), not committer_ts, not commit_id.
// DivergencePanel was sorting by commit_id and mislabeling /0 vs /1.
func ParseDivergence(output string) []DivergenceEntry {
	entries := []DivergenceEntry{}
	for line := range strings.SplitSeq(output, "\n") {
		if line == "" {
			continue
		}
		f := strings.Split(line, "\x1F")
		if len(f) != 10 {
			continue // malformed line — don't let one bad record kill the panel
		}
		entries = append(entries, DivergenceEntry{
			ChangeId:        f[0],
			CommitId:        f[1],
			Divergent:       f[2] == "1",
			ParentCommitIds: splitNonEmpty(f[3], ","),
			ParentChangeIds: splitNonEmpty(f[4], ","),
			WCReachable:     f[5] == "1",
			Bookmarks:       splitNonEmpty(f[6], "\x1E"),
			Description:     f[7],
			Empty:           f[8] == "1",
			IsWorkingCopy:   f[9] == "1",
		})
	}
	return entries
}

// StaleImmutableEntry is one commit in the stale-immutable detection dataset.
// These are immutable divergent commits — force-push leftovers from other
// machines that jj keeps as divergent copies of commits that have since been
// rewritten upstream.
type StaleImmutableEntry struct {
	ChangeId        string   `json:"change_id"`
	CommitId        string   `json:"commit_id"`
	LocalBookmarks  []string `json:"local_bookmarks"`
	RemoteBookmarks []string `json:"remote_bookmarks"`
	Description     string   `json:"description"`
}

// Full commit_id (not .short()) — these IDs flow into jj abandon -r via the
// cleanup path. Short prefixes risk ambiguity in large repos. change_id stays
// .short() since it's display-only (the grouping key, never used in commands).
const staleImmutableTemplate = `change_id.short() ++ "\x1F" ++ ` +
	`commit_id ++ "\x1F" ++ ` +
	`local_bookmarks.map(|b| b.name()).join(",") ++ "\x1F" ++ ` +
	`remote_bookmarks.map(|b| b.name() ++ "@" ++ b.remote()).join(",") ++ "\x1F" ++ ` +
	`description.first_line() ++ "\n"`

// StaleImmutable returns args for the stale-immutable detection log call.
// Revset captures immutable divergent commits — these are force-push leftovers.
func StaleImmutable() CommandArgs {
	return []string{
		"log",
		"-r", "divergent() & immutable()",
		"--no-graph",
		"--color", "never",
		"--ignore-working-copy",
		"-T", staleImmutableTemplate,
	}
}

// ParseStaleImmutable parses StaleImmutable() output into entries.
func ParseStaleImmutable(output string) []StaleImmutableEntry {
	entries := []StaleImmutableEntry{}
	for line := range strings.SplitSeq(output, "\n") {
		if line == "" {
			continue
		}
		f := strings.Split(line, "\x1F")
		if len(f) != 5 {
			continue
		}
		entries = append(entries, StaleImmutableEntry{
			ChangeId:        f[0],
			CommitId:        f[1],
			LocalBookmarks:  splitNonEmpty(f[2], ","),
			RemoteBookmarks: splitNonEmpty(f[3], ","),
			Description:     f[4],
		})
	}
	return entries
}

// StaleImmutableGroup is an actionable pair: one keeper (has bookmarks) and
// one stale copy (no bookmarks) sharing the same change_id.
type StaleImmutableGroup struct {
	ChangeId string              `json:"change_id"`
	Stale    StaleImmutableEntry `json:"stale"`
	Keeper   StaleImmutableEntry `json:"keeper"`
}

// GroupStaleImmutable groups entries by change_id and identifies actionable
// pairs where exactly one copy has bookmarks (the keeper) and the other has
// none (the stale copy safe to abandon). Non-pairs and symmetric cases are
// excluded — they need manual resolution.
func GroupStaleImmutable(entries []StaleImmutableEntry) []StaleImmutableGroup {
	groups := []StaleImmutableGroup{}
	byChange := map[string][]StaleImmutableEntry{}
	var order []string
	for _, e := range entries {
		if _, exists := byChange[e.ChangeId]; !exists {
			order = append(order, e.ChangeId)
		}
		byChange[e.ChangeId] = append(byChange[e.ChangeId], e)
	}
	for _, cid := range order {
		copies := byChange[cid]
		if len(copies) != 2 {
			continue
		}
		bm0 := len(copies[0].LocalBookmarks) + len(copies[0].RemoteBookmarks)
		bm1 := len(copies[1].LocalBookmarks) + len(copies[1].RemoteBookmarks)
		if (bm0 == 0) == (bm1 == 0) {
			continue
		}
		if bm0 > 0 {
			groups = append(groups, StaleImmutableGroup{ChangeId: cid, Keeper: copies[0], Stale: copies[1]})
		} else {
			groups = append(groups, StaleImmutableGroup{ChangeId: cid, Keeper: copies[1], Stale: copies[0]})
		}
	}
	return groups
}

// splitNonEmpty: strings.Split("", ",") returns [""] which would give us
// phantom single-element parent/bookmark arrays.
func splitNonEmpty(s, sep string) []string {
	if s == "" {
		return []string{}
	}
	return strings.Split(s, sep)
}
