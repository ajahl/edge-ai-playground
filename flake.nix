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
            pkgs.nodejs_22
            pkgs.pnpm
            pkgs.git
            pkgs.cmake
            pkgs.clang
            pkgs.pkg-config
            pkgs.playwright-driver.browsers
          ];

          # shellHook = (oldAttrs.shellHook or "") + ''
          shellHook = ''
            colima start
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

            echo ">>>>>>>>>>>> Web GPU LLM dev shell activated <<<<<<<<<<<<<<"
            docker --version
            echo "Node: $(node -v)"
            echo "Playwright browsers: $PLAYWRIGHT_BROWSERS_PATH"
            echo "Playwright executable: $PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH"
            pnpm install ws
          '';
        });
      });
}
