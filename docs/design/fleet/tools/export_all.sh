#!/bin/zsh
# 重新打包全部模型：export_all.sh <docs/design 根目录> [key...]
set -e
HERE=${0:A:h}; D=${1:?design root}; shift; B=${BLENDER:-/Volumes/WD1TB/Applications/Blender.app/Contents/MacOS/Blender}
OUT=$HERE/../packs; mkdir -p $OUT
typeset -A SRC; SRC=(station "station/orbital_station -Y 125000" claude "claudecode/claudecode_dreadnought +Y 60000" codex "codex/codex_frigate +Y 62000" kimi "kimicode/kimicode_cruiser +Y 66000" opencode "opencode/opencode_carrier +Y 62000" openclaw "openclaw/openclaw_cruiser +Y 60000" pi "pi/pi_interceptor -Y 60000" deepseek "deepseek/deepseek_explorer +Y 60000" hermes "hermes/hermes_swept_wing +Y 60000")
# 也可临时指定来源：export_all.sh <根目录> <key>=<相对路径,不带 .blend>:<船头朝向 +Y|-Y>
for a in $@; do [[ $a == *=* ]] && SRC[${a%%=*}]="${${a#*=}%%:*} ${a##*:} 60000"; done
KEYS=(); for a in $@; do KEYS+=${a%%=*}; done
for k in shuttle drone crate tile relay gateseg rock; do (( $#KEYS )) && [[ ${KEYS[(r)$k]} != $k ]] && continue; ( $B -b $HERE/../props/props.blend --factory-startup -P $HERE/export_pack.py -- $OUT/$k.pack $k +Y 20000 $k 2>&1 | grep -E "PACK|rror|Traceback" ) & done
wait
(( $#KEYS )) || KEYS=(${(k)SRC})
for k in $KEYS; do [[ -z $SRC[$k] ]] && continue; a=(${=SRC[$k]}); ( $B -b $D/$a[1].blend --factory-startup -P $HERE/export_pack.py -- $OUT/$k.pack $k $a[2] $a[3] 2>&1 | grep -E "PACK|rror|Traceback" ) & done
wait
# 网页据此得知有哪些模型
( cd $OUT && print -r -- "[$(for f in *.pack; do print -n "\"${f%.pack}\","; done | sed 's/,$//')]" > index.json )
