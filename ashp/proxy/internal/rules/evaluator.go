package rules

import (
	"regexp"
	"sort"
	"sync"
)

type Rule struct {
	ID              int      `json:"id"`
	URLPattern      string   `json:"url_pattern"`
	Methods         []string `json:"methods"`
	Action          string   `json:"action"`
	Priority        int      `json:"priority"`
	Enabled         bool     `json:"enabled"`
	DefaultBehavior string   `json:"default_behavior,omitempty"`
}

type compiledRule struct {
	Rule
	re *regexp.Regexp
}

type Evaluator struct {
	mu    sync.RWMutex
	rules []compiledRule
}

func NewEvaluator() *Evaluator { return &Evaluator{} }

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
	sort.Slice(compiled, func(i, j int) bool {
		return compiled[i].Priority > compiled[j].Priority
	})
	e.mu.Lock()
	e.rules = compiled
	e.mu.Unlock()
}

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
