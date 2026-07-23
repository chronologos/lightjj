{
  description = "Fast browser UI for Jujutsu version control";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { nixpkgs, self }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          inherit (pkgs) lib;
          version = lib.strings.removeSuffix "\n" (builtins.readFile ./version.txt);
          pnpm = pkgs.pnpm_10;
          src = lib.cleanSource self;
          frontend = pkgs.stdenv.mkDerivation {
            pname = "lightjj-frontend";
            inherit version src;

            sourceRoot = "${src.name}";

            pnpmDeps = pkgs.fetchPnpmDeps {
              pname = "lightjj-frontend";
              inherit version pnpm;
              fetcherVersion = 3;
              src = "${src}/frontend";
              hash = "sha256-8JOqt6NVL20YCJvoZ28MaZacfG4sn0CCwPLhGmZH8t4=";
            };

            nativeBuildInputs = [
              pkgs.nodejs
              pkgs.pnpmConfigHook
              pnpm
            ];

            preConfigure = ''
              cd frontend
            '';

            buildPhase = ''
              runHook preBuild

              pnpm run build

              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              cp -R ../cmd/lightjj/frontend-dist $out

              runHook postInstall
            '';
          };
        in
        {
          default = pkgs.buildGoModule {
            pname = "lightjj";
            inherit version src;

            vendorHash = "sha256-T81G54B5lCaxmtxJZG7AXJcPB4y+bGzkrNe1651DY3E=";

            env.CGO_ENABLED = "0";

            tags = [ "embed" ];

            ldflags = [
              "-s"
              "-w"
              "-X main.version=${version}"
            ];

            postPatch = ''
              cp -R ${frontend} cmd/lightjj/frontend-dist
            '';

            meta = {
              description = "Fast browser UI for Jujutsu version control";
              homepage = "https://github.com/chronologos/lightjj";
              license = lib.licenses.mit;
              mainProgram = "lightjj";
              platforms = lib.platforms.linux ++ lib.platforms.darwin;
            };

            passthru = {
              inherit frontend;
            };
          };
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/lightjj";
        };
      });

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.go
              pkgs.jujutsu
              pkgs.nodejs
              pkgs.pnpm_10
            ];
          };
        }
      );
    };
}
