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
// .join(",") required — bare list renders space-separated.
// .short() to match LogGraph — RevisionGraph highlight needs change_id equality.
const divergenceTemplate = `change_id.short() ++ "\x1F" ++ ` +
	`commit_id.short() ++ "\x1F" ++ ` +
	`if(divergent, "1", "") ++ "\x1F" ++ ` +
	`parents.map(|p| p.commit_id().short()).join(",") ++ "\x1F" ++ ` +
	`parents.map(|p| p.change_id().short()).join(",") ++ "\x1F" ++ ` +
	`if(self.contained_in("::working_copies()"), "1", "") ++ "\x1F" ++ ` +
	`local_bookmarks.map(|b| b.name()).join(",") ++ "\x1F" ++ ` +
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
			Bookmarks:       splitNonEmpty(f[6], ","),
			Description:     f[7],
			Empty:           f[8] == "1",
			IsWorkingCopy:   f[9] == "1",
		})
	}
	return entries
}

// splitNonEmpty: strings.Split("", ",") returns [""] which would give us
// phantom single-element parent/bookmark arrays.
func splitNonEmpty(s, sep string) []string {
	if s == "" {
		return []string{}
	}
	return strings.Split(s, sep)
}
