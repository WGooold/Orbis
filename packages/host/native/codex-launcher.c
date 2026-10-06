/*
 * Orbis 的 Codex 桌面版包装器入口（PE）。
 *
 * 为什么必须是原生 exe：Codex 桌面版启动它的 CLI 时不带 shell，`.cmd` 不是可执行
 * 影像，CreateProcess 会失败。这个程序只做一件事——把同样的 argv 和继承来的
 * stdio 交给 `node codex-desktop-wrapper.js`。
 *
 * 路径解析顺序（都是相对于本 exe，或由环境变量显式指定，所以整个运行时目录可以
 * 整体搬走）：
 *   1. ORBIS_CODEX_WRAPPER_NODE / ORBIS_CODEX_WRAPPER_SCRIPT
 *   2. <exe 目录>\..\node\node.exe 与 <exe 目录>\..\packages\host\dist\codex-desktop-wrapper.js
 *
 * 失败语义：包装器只允许失败在「接不上」，不允许让桌面版打不开。node 或脚本缺失
 * 时若环境里给了 ORBIS_CODEX_REAL（真实 CLI），就直接跑它；否则报 127。
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <process.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

#define ORBIS_PATH_MAX 4096
#define ORBIS_ARGV_MAX 512

static int read_env(const wchar_t *name, wchar_t *buffer, DWORD capacity) {
    DWORD length = GetEnvironmentVariableW(name, buffer, capacity);
    if (length == 0 || length >= capacity) {
        buffer[0] = L'\0';
        return 0;
    }
    return 1;
}

static int file_exists(const wchar_t *path) {
    DWORD attributes = GetFileAttributesW(path);
    return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

/** 把 base\..\suffix 拼进 buffer；失败返回 0。 */
static int join_relative(const wchar_t *base, const wchar_t *suffix, wchar_t *buffer, size_t capacity) {
    int written = _snwprintf(buffer, capacity, L"%ls\\..\\%ls", base, suffix);
    return written > 0 && (size_t)written < capacity;
}

int main(void) {
    wchar_t self[ORBIS_PATH_MAX];
    wchar_t node[ORBIS_PATH_MAX];
    wchar_t script[ORBIS_PATH_MAX];
    node[0] = L'\0';
    script[0] = L'\0';

    if (GetModuleFileNameW(NULL, self, ORBIS_PATH_MAX) == 0) return 127;
    wchar_t *slash = wcsrchr(self, L'\\');
    if (slash != NULL) *slash = L'\0';

    if (!read_env(L"ORBIS_CODEX_WRAPPER_NODE", node, ORBIS_PATH_MAX)) {
        if (!join_relative(self, L"node\\node.exe", node, ORBIS_PATH_MAX)) node[0] = L'\0';
    }
    if (!read_env(L"ORBIS_CODEX_WRAPPER_SCRIPT", script, ORBIS_PATH_MAX)) {
        if (!join_relative(self, L"packages\\host\\dist\\codex-desktop-wrapper.js", script, ORBIS_PATH_MAX)) script[0] = L'\0';
    }

    int argc = 0;
    wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (argv == NULL || argc < 1) return 127;

    if (node[0] != L'\0' && script[0] != L'\0' && file_exists(node) && file_exists(script)) {
        wchar_t **child = (wchar_t **)calloc((size_t)argc + 2, sizeof(wchar_t *));
        if (child == NULL) {
            LocalFree(argv);
            return 127;
        }
        child[0] = node;
        child[1] = script;
        for (int index = 1; index < argc; index++) child[index + 1] = argv[index];
        child[argc + 1] = NULL;
        intptr_t status = _wspawnv(_P_WAIT, node, (const wchar_t *const *)child);
        free(child);
        LocalFree(argv);
        return status == -1 ? 127 : (int)status;
    }

    // 包装器不完整：不要让桌面版开不了。退回环境里给出的真实 CLI。
    wchar_t real[ORBIS_PATH_MAX];
    if (read_env(L"ORBIS_CODEX_REAL", real, ORBIS_PATH_MAX) && file_exists(real)) {
        wchar_t **child = (wchar_t **)calloc((size_t)argc + 1, sizeof(wchar_t *));
        if (child == NULL) {
            LocalFree(argv);
            return 127;
        }
        child[0] = real;
        for (int index = 1; index < argc; index++) child[index] = argv[index];
        child[argc] = NULL;
        intptr_t status = _wspawnv(_P_WAIT, real, (const wchar_t *const *)child);
        free(child);
        LocalFree(argv);
        return status == -1 ? 127 : (int)status;
    }

    fwprintf(stderr, L"[orbis-codex-wrapper] 缺少包装器运行时（node=%ls script=%ls），且没有 ORBIS_CODEX_REAL 可回退\n", node, script);
    LocalFree(argv);
    return 127;
}
