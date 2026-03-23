// Package rules implements a rule-matching engine that determines whether an
// outbound HTTP request should be allowed, denied, or handled by a default
// behavior policy.
//
// Rules are regex-based URL patterns with optional HTTP method filters, an
// action (allow/deny), a numeric priority (higher wins), and optional body
// logging policies. Rules are loaded atomically via [Evaluator.Load] and
// matched in priority-descending order by [Evaluator.Match].
//
// All methods on [Evaluator] are safe for concurrent use.
package rules

import (
	"regexp"
	"sort"
	"sync"
)

// Rule defines a single access-control rule as received from the control
// plane.
//
// Fields:
//   - ID:              unique rule identifier.
//   - URLPattern:      a Go regexp that is matched against the full request URL
//     (scheme + host + path + query).
//   - Methods:         if non-empty, the rule only matches requests whose HTTP
//     method is in this list. An empty slice matches all methods.
//   - Action:          "allow" or "deny". Determines whether matched requests
//     are forwarded or blocked.
//   - Priority:        higher values are evaluated first. Among rules with
//     equal priority, the first loaded wins.
//   - Enabled:         disabled rules are skipped during [Evaluator.Load].
//   - DefaultBehavior: if set, overrides the proxy's global default behavior
//     for requests that match this rule's URL pattern but not its
//     action (used for partial-match scenarios).
//   - LogRequestBody:  body logging policy for requests: "none", "full", or
//     "truncate:<max_bytes>".
//   - LogResponseBody: body logging policy for responses (same format).
type Rule struct {
	ID              int      `json:"id"`
	URLPattern      string   `json:"url_pattern"`
	Methods         []string `json:"methods"`
	Action          string   `json:"action"`
	Priority        int      `json:"priority"`
	Enabled         bool     `json:"enabled"`
	DefaultBehavior string   `json:"default_behavior,omitempty"`
	LogRequestBody  string   `json:"log_request_body,omitempty"`
	LogResponseBody string   `json:"log_response_body,omitempty"`
}

// compiledRule pairs a Rule with its pre-compiled regexp for efficient
// repeated matching.
type compiledRule struct {
	Rule
	re *regexp.Regexp
}

// Evaluator holds a sorted set of compiled rules and provides thread-safe
// rule matching. Rules are replaced atomically via [Evaluator.Load].
type Evaluator struct {
	mu    sync.RWMutex
	rules []compiledRule
}

// NewEvaluator returns an Evaluator with an empty rule set.
func NewEvaluator() *Evaluator { return &Evaluator{} }

// Load replaces the evaluator's rule set atomically. It filters out disabled
// rules and rules with invalid regex patterns, compiles the remaining
// patterns, and sorts them by descending priority so that [Evaluator.Match]
// returns the highest-priority match.
func (e *Evaluator) Load(rules []Rule) {
	compiled := make([]compiledRule, 0, len(rules))
	for _, r := range rules {
		if !r.Enabled {
			continue
		}
		re, err := regexp.Compile(r.URLPattern)
		if err != nil {
			continue
		}
		compiled = append(compiled, compiledRule{Rule: r, re: re})
	}
	// Sort by descending priority so the first match is the highest priority.
	sort.Slice(compiled, func(i, j int) bool {
		return compiled[i].Priority > compiled[j].Priority
	})
	e.mu.Lock()
	e.rules = compiled
	e.mu.Unlock()
}

// Match finds the highest-priority rule whose URL pattern matches the given
// url and (if the rule specifies methods) whose method list includes the
// given method. Returns nil if no rule matches.
//
// The evaluation algorithm is:
//  1. Acquire a read lock on the rule set.
//  2. Iterate rules in priority-descending order.
//  3. For each rule, test the compiled regexp against url.
//  4. If the rule has a non-empty Methods list, check that method is present.
//  5. Return a copy of the first fully-matching Rule, or nil.
func (e *Evaluator) Match(url, method string) *Rule {
	e.mu.RLock()
	defer e.mu.RUnlock()
	for _, cr := range e.rules {
		if !cr.re.MatchString(url) {
			continue
		}
		if len(cr.Methods) > 0 {
			found := false
			for _, m := range cr.Methods {
				if m == method {
					found = true
					break
				}
			}
			if !found {
				continue
			}
		}
		r := cr.Rule
		return &r
	}
	return nil
}
