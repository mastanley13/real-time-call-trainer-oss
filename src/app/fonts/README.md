# Fonts

`RadioCanadaBig-latin-wght.woff2` is Radio Canada Big (variable weight, Latin subset) from the Fontsource package
`@fontsource-variable/radio-canada-big` 5.3.0, under the SIL Open Font License 1.1 (`OFL.txt`). No Reserved Font Name is
declared.

One change from upstream: the `tnum` (tabular figures) feature now swaps only the ten digits. Upstream it also swapped the
word space and the colon, comma, semicolon and period for wide tabular forms, and the app turns tabular figures on for
every table, clock and score, so words and times in the same text spread apart ("Nov  4", "0 : 07"). Digits still align.
Made with fontTools by deleting those five entries from the `tnum` single substitution.
