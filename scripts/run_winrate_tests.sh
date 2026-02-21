#!/bin/bash
# Skill Winrate Simulation Runner
# Runs multiple test scenarios for V1 and V2 engines

CONFIG_V3="/Users/bogdanbrinzoiu/Work/icp-orbs/configs/gameConfig.v3.0.0.json"
TRIALS=${1:-50}
PLAYERS=${2:-8}

echo "=============================================="
echo "  Skill Winrate Simulation Suite"
echo "  Trials: $TRIALS | Players: $PLAYERS"
echo "=============================================="
echo ""

cd "$(dirname "$0")/.."

# V1 Tests
echo ">>> V1 Engine Tests <<<"
echo ""

echo "--- V1: Default (PROD v1.2.2) ---"
bun scripts/sim_skill_winrate.ts --trials $TRIALS --players $PLAYERS 2>/dev/null | grep -v "Economics"
echo ""

echo "--- V1: Config v3.0.0 ---"
bun scripts/sim_skill_winrate.ts --trials $TRIALS --players $PLAYERS --config "$CONFIG_V3" 2>/dev/null | grep -v "Economics"
echo ""

echo "--- V1: Only Split Aggro ---"
bun scripts/sim_skill_winrate.ts --trials $TRIALS --players $PLAYERS --config "$CONFIG_V3" --only-split 2>/dev/null | grep -v "Economics"
echo ""

echo "--- V1: Only Tether Defense ---"
bun scripts/sim_skill_winrate.ts --trials $TRIALS --players $PLAYERS --config "$CONFIG_V3" --only-tether 2>/dev/null | grep -v "Economics"
echo ""

echo "--- V1: Only Power ---"
bun scripts/sim_skill_winrate.ts --trials $TRIALS --players $PLAYERS --config "$CONFIG_V3" --only-power 2>/dev/null | grep -v "Economics"
echo ""

# V2 Tests
echo ">>> V2 Engine Tests (Fixed-Point) <<<"
echo ""

echo "--- V2: Config v3.0.0 ---"
bun scripts/sim_skill_winrate.ts --trials $TRIALS --players $PLAYERS --config "$CONFIG_V3" --v2 2>/dev/null | grep -v "Economics"
echo ""

echo "--- V2: Only Split Aggro ---"
bun scripts/sim_skill_winrate.ts --trials $TRIALS --players $PLAYERS --config "$CONFIG_V3" --only-split --v2 2>/dev/null | grep -v "Economics"
echo ""

echo "--- V2: Only Tether Defense ---"
bun scripts/sim_skill_winrate.ts --trials $TRIALS --players $PLAYERS --config "$CONFIG_V3" --only-tether --v2 2>/dev/null | grep -v "Economics"
echo ""

echo "--- V2: Only Power ---"
bun scripts/sim_skill_winrate.ts --trials $TRIALS --players $PLAYERS --config "$CONFIG_V3" --only-power --v2 2>/dev/null | grep -v "Economics"
echo ""

echo "=============================================="
echo "  Complete!"
echo "=============================================="
