#!/usr/bin/env bash
# Usage: ./verify-headline.sh [URL]   Exit 0 only if every new string is present and every old string is gone.
URL="${1:-https://calltrainer.tech/}"
RAW=$(curl -fsSL -H 'Cache-Control: no-cache' "${URL}?cb=$(date +%s)") || { echo "FETCH FAILED"; exit 2; }
TEXT=$(printf '%s' "$RAW" \
  | sed -e 's/<[^>]*>/ /g' -e "s/&#x27;/'/g" -e "s/&#39;/'/g" -e "s/&apos;/'/g" -e 's/&amp;/\&/g' -e 's/&middot;/·/g' \
  | tr '\n' ' ' | tr -s ' ')
fail=0
must_have() { if grep -qF -- "$1" <<<"$TEXT"; then echo "PASS present: $1"; else echo "FAIL missing: $1"; fail=1; fi; }
must_lack()  { if grep -qF -- "$1" <<<"$TEXT"; then echo "FAIL still present: $1"; fail=1; else echo "PASS absent:  $1"; fi; }
# NEW strings (R1-R8, I1)
must_have "Know which reps are ready before they're on a live call."
must_have "Your reps practice against 54 AI buyers who push back. You read a graded debrief that quotes their own words, so you can see who is ready and what to coach next. Free to start, no card."
must_have "Start free, no card"
# R3: the old label "Start free" is a substring of the new one (and "Start free, no setup" stays in the meta tags), so it cannot be checked as absent.
# Instead read the label of the hero button itself (the link to /register?src=home_hero) and require it to be exactly the new label.
HERO=$(printf '%s' "$RAW" | grep -o 'href="/register?src=home_hero">[^<]*' | head -1 | sed -e 's/.*">//' -e 's/[[:space:]]*$//')
if [ "$HERO" = "Start free, no card" ]; then echo "PASS hero button label is exactly: $HERO"; else echo "FAIL hero button label is: '$HERO' (want 'Start free, no card')"; fail=1; fi
must_have "54 AI buyers across 18 sales jobs"
must_have "From SDR cold calls to insurance renewals, portal leads and past-due calls. Filter by role, industry, difficulty and the objection they throw."
must_have "A live score on every turn, talk-track progress and a line your rep can use. Train Blind, Guided or Coached, so you choose how much help each rep gets."
must_have "A debrief that quotes your rep's own words"
must_have "Every score cites what the rep actually said, checked against the transcript. Open a quote to see the moment, then retry the call from that turn."
must_have "Managing 3 or more reps? Team adds a manager view and assignments: \$59 a seat a month, 3-seat minimum."
# OLD strings (must be gone)
must_lack "Sales call practice, no setup required"
must_lack "No API keys, no database, just sign up and start talking."
must_lack "54 personas, 18 sales jobs"
must_lack "Each persona is a plain JSON pack."
must_lack "Live rubric estimate, talk-track progress and talk ratio"
must_lack "Evidence-backed debrief"
must_lack "Scores cite verbatim quotes that are checked against the transcript."
# UNCHANGED strings (must still be there)
must_have "Free tier · no card · text or voice"
must_have "See pricing"
must_have "A live coach, not a script"
# Price guard: the add-on price must not appear in the new copy
must_lack "Premium"
if [ $fail -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "CHECKS FAILED"; fi
exit $fail
