#!/usr/bin/env bash
# Download the self-hosted fonts and subset them to woff2 in public/fonts/.
# All OFL. Urdu faces keep the Arabic blocks plus space, digits and ASCII punctuation, so word
# spaces, Western digits (the default for Urdu dates) and brackets inside Urdu text come from the
# Urdu face; only Latin letters fall through to Inter (see the Urdu stacks in app/globals.css).
# The Arabic block U+0600-06FF includes the harakat (U+064B-0652) and the superscript alef (U+0670),
# which the name تبیُّن and the Quranic verse on the About page need (Naskh sets the verse).
# After a re-run bump FONT_VERSION in lib/fonts.ts (/fonts/ is served with an immutable cache) and
# keep its URDU_RANGE equal to ARABIC below.
#
# Usage: npm run fonts                              every face
#        bash scripts/fonts.sh nastaliq naskh vazir  only these (nastaliq naskh vazir inter newsreader gulzar)
set -euo pipefail
cd "$(dirname "$0")/.."
out=public/fonts; tmp=$(mktemp -d); mkdir -p "$out"; trap 'rm -rf "$tmp"' EXIT
ARABIC='U+0020-0040,U+005B-0060,U+007B-007E,U+00A0,U+00AB,U+00BB,U+0600-06FF,U+0750-077F,U+0870-088E,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFC,U+200C-200F,U+2010-2011'
LATIN='U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
sub() { uv tool run --python 3.12 --from 'fonttools[woff,unicode]' pyftsubset "$@"; }
asset() { # $1 repo, $2 python filter expr on asset name
  curl -sS "https://api.github.com/repos/$1/releases?per_page=20" | python3 -c "
import sys,json
for r in json.load(sys.stdin):
  for a in r.get('assets',[]):
    n=a['name']
    if $2: print(a['browser_download_url']); raise SystemExit"
}
want() { [ $# -eq 0 ] || [ ${#only[@]} -eq 0 ] && return 0; local s; for s in "${only[@]}"; do [ "$s" = "$1" ] && return 0; done; return 1; }
only=("$@")

if want nastaliq; then
  echo "1. Noto Nastaliq Urdu v4 (GitHub release; Google Fonts still serves 3.009)"
  url=$(asset notofonts/nastaliq "n.startswith('NotoNastaliqUrdu-v4') and n.endswith('.zip')")
  echo "   $url"; curl -sSL "$url" -o "$tmp/nastaliq.zip"; unzip -qo "$tmp/nastaliq.zip" -d "$tmp/nastaliq"
  ttf=$(find "$tmp/nastaliq" -name 'NotoNastaliqUrdu\[wght\].ttf' | head -1)
  sub "$ttf" --flavor=woff2 --layout-features='*' --unicodes="$ARABIC" --output-file="$out/NotoNastaliqUrdu[wght].woff2"
fi

if want naskh; then
  echo "2. Noto Naskh Arabic (google/fonts main)"
  curl -sSL 'https://github.com/google/fonts/raw/main/ofl/notonaskharabic/NotoNaskhArabic%5Bwght%5D.ttf' -o "$tmp/naskh.ttf"
  sub "$tmp/naskh.ttf" --flavor=woff2 --layout-features='*' --unicodes="$ARABIC" --output-file="$out/NotoNaskhArabic[wght].woff2"
fi

if want vazir; then
  echo "3. Vazirmatn (UI)"
  url=$(asset rastikerdar/vazirmatn "n.endswith('.zip')")
  echo "   $url"; curl -sSL "$url" -o "$tmp/vazir.zip"; unzip -qo "$tmp/vazir.zip" -d "$tmp/vazir"
  vttf=$(find "$tmp/vazir" -name 'Vazirmatn\[wght\].ttf' | head -1)
  sub "$vttf" --flavor=woff2 --layout-features='*' --unicodes="$ARABIC" --output-file="$out/Vazirmatn[wght].woff2"
fi

if want inter; then
  echo "4. Inter (English body/UI; the italic is kept but not loaded, see lib/fonts.ts)"
  url=$(asset rsms/inter "n.startswith('Inter-') and n.endswith('.zip')")
  echo "   $url"; curl -sSL "$url" -o "$tmp/inter.zip"; unzip -qo "$tmp/inter.zip" -d "$tmp/inter"
  sub "$(find "$tmp/inter" -name "InterVariable.woff2" | head -1)" --flavor=woff2 --layout-features="*" --unicodes="$LATIN" --output-file="$out/InterVariable.woff2"
  sub "$(find "$tmp/inter" -name "InterVariable-Italic.woff2" | head -1)" --flavor=woff2 --layout-features="*" --unicodes="$LATIN" --output-file="$out/InterVariable-Italic.woff2"
fi

if want newsreader; then
  echo "5. Newsreader (English headlines, Classic theme)"
  curl -sSL 'https://github.com/google/fonts/raw/main/ofl/newsreader/Newsreader%5Bopsz,wght%5D.ttf' -o "$tmp/newsreader.ttf"
  sub "$tmp/newsreader.ttf" --flavor=woff2 --layout-features='*' --unicodes="$LATIN" --output-file="$out/Newsreader[opsz,wght].woff2"
fi

if want gulzar; then
  echo "6. Gulzar (alternative Nastaliq headline face)"
  curl -sSL 'https://github.com/google/fonts/raw/main/ofl/gulzar/Gulzar-Regular.ttf' -o "$tmp/gulzar.ttf"
  sub "$tmp/gulzar.ttf" --flavor=woff2 --layout-features='*' --unicodes="$ARABIC" --output-file="$out/Gulzar-Regular.woff2"
fi

ls -la "$out"
