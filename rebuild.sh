source ./emsdk/emsdk_env.sh

cd ./mlc-llm
rm -rf ./web/dist ./3rdparty/tvm/web/dist
./web/prep_emcc_deps.sh

cd ../web-llm
rm -rf node_modules lib
pnpm install --force
npm run build

cd ../terminal-webgpu-llm
rm -rf node_modules dist
pnpm install --force
pnpm build