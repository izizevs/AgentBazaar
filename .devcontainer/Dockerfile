FROM node:22-trixie

ARG TZ
ENV TZ="$TZ"

# Install basic development tools and iptables/ipset
RUN apt-get update && apt-get install -y --no-install-recommends \
  less \
  git \
  procps \
  sudo \
  fzf \
  zsh \
  man-db \
  unzip \
  gnupg2 \
  gh \
  iptables \
  ipset \
  iproute2 \
  dnsutils \
  aggregate \
  jq \
  nano \
  vim \
  tmux \
  locales \
  ripgrep \
  fd-find \
  && sed -i '/en_US.UTF-8/s/^# //' /etc/locale.gen \
  && locale-gen \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# AgentBazaar: build deps for Solana/Anchor native compilation + psql client for debugging
# libclang-dev is pulled in for bindgen inside agave's secp256k1 / zstd crates
# when cargo-installing solana-test-validator; without it, bindgen panics
# "Unable to find libclang" mid-compile (see docs/decisions/0001-sbf-toolchain-workarounds.md).
RUN apt-get update && apt-get install -y --no-install-recommends \
  build-essential \
  pkg-config \
  libssl-dev \
  libudev-dev \
  libclang-dev \
  protobuf-compiler \
  ca-certificates \
  postgresql-client \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# AgentBazaar: k6 load-testing tool (binary from GitHub — k6 apt repo doesn't ship arm64)
RUN K6_VERSION=$(curl -fsSL https://api.github.com/repos/grafana/k6/releases/latest \
      | grep -Po '"tag_name": "v\K[^"]*') && \
    ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/grafana/k6/releases/download/v${K6_VERSION}/k6-v${K6_VERSION}-linux-${ARCH}.tar.gz" \
      | tar xz -C /tmp && \
    mv "/tmp/k6-v${K6_VERSION}-linux-${ARCH}/k6" /usr/local/bin/k6 && \
    rm -rf "/tmp/k6-v${K6_VERSION}-linux-${ARCH}"

# Ensure default node user has access to /usr/local/share
RUN mkdir -p /usr/local/share/npm-global && \
  chown -R node:node /usr/local/share

ARG USERNAME=node

# Persist bash history.
RUN SNIPPET="export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  && mkdir /commandhistory \
  && touch /commandhistory/.bash_history \
  && chown -R $USERNAME /commandhistory

# Set `DEVCONTAINER` environment variable to help with orientation
ENV DEVCONTAINER=true
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# Create workspace and config directories and set permissions
RUN mkdir -p /workspace /home/node/.claude /home/node/.local/share/nvim && \
  chown -R node:node /workspace /home/node/.claude /home/node/.local

WORKDIR /workspace

# Install Neovim (latest stable)
ARG NVIM_VERSION=stable
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then NVIM_ARCH="x86_64"; else NVIM_ARCH="arm64"; fi && \
    curl -fsSL "https://github.com/neovim/neovim/releases/download/${NVIM_VERSION}/nvim-linux-${NVIM_ARCH}.tar.gz" | \
    tar xz -C /usr/local --strip-components=1

# Install lazygit
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then LG_ARCH="x86_64"; else LG_ARCH="arm64"; fi && \
    LAZYGIT_VERSION=$(curl -s "https://api.github.com/repos/jesseduffield/lazygit/releases/latest" | grep -Po '"tag_name": "v\K[^"]*') && \
    curl -fsSL "https://github.com/jesseduffield/lazygit/releases/download/v${LAZYGIT_VERSION}/lazygit_${LAZYGIT_VERSION}_Linux_${LG_ARCH}.tar.gz" | \
    tar xz -C /usr/local/bin lazygit

ARG GIT_DELTA_VERSION=0.18.2
RUN ARCH=$(dpkg --print-architecture) && \
  wget "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  sudo dpkg -i "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  rm "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb"

# Set up non-root user
USER node

# Install global packages
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

# Set the default shell to zsh rather than sh
ENV SHELL=/bin/zsh

# Set the default editor and visual
ENV EDITOR=nvim
ENV VISUAL=nvim

# Default powerline10k theme
ARG ZSH_IN_DOCKER_VERSION=1.2.0
RUN sh -c "$(wget -O- https://github.com/deluan/zsh-in-docker/releases/download/v${ZSH_IN_DOCKER_VERSION}/zsh-in-docker.sh)" -- \
  -p git \
  -p fzf \
  -a "source /usr/share/doc/fzf/examples/key-bindings.zsh" \
  -a "source /usr/share/doc/fzf/examples/completion.zsh" \
  -a "export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  -x

# Install Claude Code (native installer)
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/node/.local/bin:$PATH"

# AgentBazaar: pnpm via corepack (Node 22 ships with corepack)
# Corepack needs to write symlinks to /usr/local/bin, so run as root briefly
USER root
RUN corepack enable && corepack prepare pnpm@latest --activate
USER node

# AgentBazaar: Rust stable toolchain (needed for Anchor programs + AVM)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --default-toolchain stable --profile minimal
ENV PATH="/home/node/.cargo/bin:$PATH"

# Solana CLI + Anchor are installed per-agent on first use via scripts/install-solana-toolchain.sh
# Rationale: agave arm64-linux has no official prebuilt binary; source builds hit Rust version
# conflicts that are faster to iterate on inside a running container than across rebuild cycles.
# Only the anchor-eng agent actually needs these tools — no need to block the whole team's rebuild.

# tmux config
RUN cd /home/node \
    && git clone https://github.com/gpakosz/.tmux.git .tmux \
    && ln -s -f .tmux/.tmux.conf .

# LazyVim
RUN git clone https://github.com/LazyVim/starter /home/node/.config/nvim \
    && rm -rf /home/node/.config/nvim/.git

# Fix $TERM inside tmux
RUN echo '\n# Use correct TERM inside tmux\nif [ -n "$TMUX" ]; then export TERM=tmux-256color; fi' >> /home/node/.zshrc

# Copy and set up firewall script
COPY init-firewall.sh /usr/local/bin/
USER root
RUN chmod +x /usr/local/bin/init-firewall.sh && \
  echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/node-firewall && \
  chmod 0440 /etc/sudoers.d/node-firewall
USER node
