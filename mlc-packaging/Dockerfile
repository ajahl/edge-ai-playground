FROM continuumio/miniconda3:25.1.1-2

SHELL ["/bin/bash", "-lc"]

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    git-lfs \
    curl \
    ca-certificates \
    build-essential \
    cmake \
    nodejs \
    npm \
    python3 \
    xz-utils \
    unzip \
    && rm -rf /var/lib/apt/lists/*

ENV EMSDK=/opt/emsdk
ENV PATH="${EMSDK}:${EMSDK}/upstream/emscripten:${PATH}"

RUN git clone https://github.com/emscripten-core/emsdk.git ${EMSDK} \
    && cd ${EMSDK} \
    && ./emsdk install 3.1.56 \
    && ./emsdk activate 3.1.56

RUN conda create -y -n mlc python=3.13 && conda clean -afy

RUN source /opt/conda/etc/profile.d/conda.sh \
    && conda activate mlc \
    && python -m pip install --pre -U -f https://mlc.ai/wheels \
      mlc-llm-nightly-cpu \
      mlc-ai-nightly-cpu \
      huggingface_hub[cli] \
      scikit-build-core \
      ninja \
      cmake

RUN curl https://sh.rustup.rs -sSf | bash -s -- -y
ENV PATH="/root/.cargo/bin:/opt/emsdk:/opt/emsdk/upstream/emscripten:${PATH}"
RUN rustc --version && cargo --version

WORKDIR /workspace

COPY run.sh /workspace/run.sh
COPY rebuild-custom-wasm.sh /usr/local/bin/rebuild-custom-wasm.sh

ARG MLC_LLM_GIT_URL=""
ARG MLC_LLM_GIT_REF=""
ARG MLC_LLM_LOCAL_PATH=""

RUN chmod +x /workspace/run.sh /usr/local/bin/rebuild-custom-wasm.sh

RUN source /opt/conda/etc/profile.d/conda.sh \
    && conda activate mlc \
    && if [ -n "${MLC_LLM_LOCAL_PATH}" ]; then \
         python -m pip install -e "${MLC_LLM_LOCAL_PATH}"; \
       elif [ -n "${MLC_LLM_GIT_URL}" ]; then \
         git clone "${MLC_LLM_GIT_URL}" /opt/mlc-llm-custom; \
         cd /opt/mlc-llm-custom; \
         if [ -n "${MLC_LLM_GIT_REF}" ]; then git checkout "${MLC_LLM_GIT_REF}"; fi; \
         python -m pip install -e .; \
       fi

ENTRYPOINT ["/bin/bash", "-lc"]
CMD ["source /opt/conda/etc/profile.d/conda.sh && conda activate mlc && ./run.sh"]
