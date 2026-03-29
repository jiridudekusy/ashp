// Package rules implements a rule-matching engine that determines whether an
// outbound HTTP request should be allowed, denied, or handled by a default
// behavior policy.
//
// Rules are regex-based URL patterns with optional HTTP method filters, an
// action (allow/deny), a numeric priority (higher wins), and optional body
// logging policies. Rules are loaded atomically via [Evaluator.Load] or
// [Evaluator.LoadMap] and matched in priority-descending order by
// [Evaluator.Match].
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

// Evaluator holds a per-agent map of sorted compiled rules and provides
// thread-safe rule matching. Rules are replaced atomically via
// [Evaluator.Load] or [Evaluator.LoadMap].
type Evaluator struct {
	mu      sync.RWMutex
	byAgent map[string][]compiledRule
}

// NewEvaluator returns an Evaluator with an empty rule set.
func NewEvaluator() *Evaluator {
	return &Evaluator{byAgent: make(map[string][]compiledRule)}
}

// LoadMap replaces the rule set with a per-agent map. For each agent, it
// filters out disabled rules and rules with invalid regex patterns, compiles
// the remaining patterns, and sorts them by descending priority so that
// [Evaluator.Match] returns the highest-priority match.
func (e *Evaluator) LoadMap(agentRules map[string][]Rule) {
	byAgent := make(map[string][]compiledRule, len(agentRules))
	for agent, rules := range agentRules {
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
		byAgent[agent] = compiled
	}
	e.mu.Lock()
	e.byAgent = byAgent
	e.mu.Unlock()
}

// Load replaces the evaluator's rule set with a flat list (backwards compat).
// It stores the rules under the special "__all__" agent key, which is
// matched by [Evaluator.Match] when no per-agent rules are found.
func (e *Evaluator) Load(rules []Rule) {
	e.LoadMap(map[string][]Rule{"__all__": rules})
}

// Match finds the highest-priority rule whose URL pattern matches the given
// url and (if the rule specifies methods) whose method list includes the
// given method. It looks up rules for the specific agentID first; if none are
// found, it falls back to the "__all__" bucket (populated by [Evaluator.Load]).
// Returns nil if no rule matches.
//
// The evaluation algorithm is:
//  1. Acquire a read lock on the rule set.
//  2. Look up the rule list for agentID (falling back to "__all__").
//  3. Iterate rules in priority-descending order.
//  4. For each rule, test the compiled regexp against url.
//  5. If the rule has a non-empty Methods list, check that method is present.
//  6. Return a copy of the first fully-matching Rule, or nil.
func (e *Evaluator) Match(agentID, url, method string) *Rule {
	e.mu.RLock()
	defer e.mu.RUnlock()
	rules := e.byAgent[agentID]
	for _, cr := range rules {
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
