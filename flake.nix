{
  description = "WebLLM dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    docker-flake = {
      url = "github:ajahl/docker-flake";
      flake = true;
    };
    oh-my-bash = {
      url = "github:ohmybash/oh-my-bash";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, flake-utils, docker-flake, oh-my-bash }@inputs:
    flake-utils.lib.eachDefaultSystem (system:
      
      let
        pkgs = import nixpkgs { inherit system; };
      
      in {
        devShells.default =
          docker-flake.devShell.${system}.overrideAttrs (oldAttrs: {
          # nix-env -qaP | grep chromium
          buildInputs = (oldAttrs.buildInputs or []) ++ [
            pkgs.nodejs_24
            pkgs.pnpm
            pkgs.git
            pkgs.ripgrep
            pkgs.cmake
            pkgs.clang
            pkgs.pkg-config
            pkgs.python311
            pkgs.playwright-driver.browsers
          ];

          # shellHook = (oldAttrs.shellHook or "") + ''
          shellHook = ''
            colima start --cpu 8 --memory 24
            export LANG=en_US.UTF-8
            export PLAYWRIGHT_BROWSERS_PATH="${pkgs.playwright-driver.browsers}"
            export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
            export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
            export PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH="$(
              find -L "$PLAYWRIGHT_BROWSERS_PATH" \
                \( -name Chromium -o -name chrome -o -name headless_shell -o -name chrome.exe -o -name 'Google Chrome for Testing' \) \
                -type f 2>/dev/null | head -n 1
            )"

            export OSH="${inputs.oh-my-bash}"
            export OSH_THEME="agnoster"

            if [ -f "$OSH/oh-my-bash.sh" ]; then
              source "$OSH/oh-my-bash.sh"
            fi

            export EMSDK="$(pwd)/emsdk"
            if [ ! -d "$EMSDK" ]; then
              echo "Warning: ./emsdk is missing."
              echo "Clone it with: git clone https://github.com/emscripten-core/emsdk.git ./emsdk"
            elif [ ! -x "$EMSDK/upstream/emscripten/emcc" ]; then
              echo "Warning: emsdk exists but Emscripten is not installed/activated yet."
              echo "Run:"
              echo "  cd ./emsdk"
              echo "  ./emsdk install 3.1.56"
              echo "  ./emsdk activate 3.1.56"
              echo "  source emsdk_env.sh"
            elif [ -f "$EMSDK/emsdk_env.sh" ]; then
              source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
            else
              echo "Warning: ./emsdk/emsdk_env.sh not found."
            fi

            echo ">>>>>>>>>>>> Web GPU LLM dev shell activated <<<<<<<<<<<<<<"
            docker --version
            echo "Node: $(node -v)"
            if command -v emcc >/dev/null 2>&1; then
              echo "Emscripten: $(emcc --version | head -n 1)"
            else
              echo "Warning: emcc is not available in this shell."
            fi
            echo "Playwright browsers: $PLAYWRIGHT_BROWSERS_PATH"
            echo "Playwright executable: $PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH"
            pnpm install ws
            source .venv/bin/activate
          '';
        });
      });
}
