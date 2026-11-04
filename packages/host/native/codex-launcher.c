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
 * 参数必须**原样**搬运：桌面版启动时会传
 *   app-server --print-startup-config --startup-client-info {"name":"codex_desktop",…}
 * 里面的 JSON 带引号，桌面版读它来判断能否安全启动。`_wspawnv` 只给含空格的参数加
 * 外层引号、不转义原有的引号，那对引号到子进程时会被剥掉，JSON 变成非法（codex 以 2
 * 退出），桌面版随即停在「组织设置无法加载」。所以这里自己拼命令行：把
 * `GetCommandLineW()` 里程序名之后的原串直接接在后面，保持调用方给出的引号形态。
 *
 * 失败语义：包装器只允许失败在「接不上」，不允许让桌面版打不开。node 或脚本缺失
 * 时若环境里给了 ORBIS_CODEX_REAL（真实 CLI），就直接跑它；否则报 127。
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

#define ORBIS_PATH_MAX 4096

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

/** 跳过命令行里的程序名（与 CommandLineToArgvW 同一套引号规则），返回参数部分的起点。 */
static const wchar_t *skip_program_name(const wchar_t *line) {
    const wchar_t *cursor = line;
    if (*cursor == L'"') {
        cursor++;
        while (*cursor != L'\0' && *cursor != L'"') cursor++;
        if (*cursor == L'"') cursor++;
    } else {
        while (*cursor != L'\0' && *cursor != L' ' && *cursor != L'\t') cursor++;
    }
    while (*cursor == L' ' || *cursor == L'\t') cursor++;
    return cursor;
}

/**
 * 启动 `<program> <prefix_arg?> <tail>`，其中 tail 是调用方原始命令行里程序名之后的
 * 原串（引号、空格都不动），stdio 沿用本进程的三个标准句柄。
 */
static int run_verbatim(const wchar_t *program, const wchar_t *prefix_arg, const wchar_t *tail, const wchar_t *label) {
    size_t capacity = wcslen(program) + wcslen(tail) + wcslen(label) + 32;
    if (prefix_arg != NULL) capacity += wcslen(prefix_arg);
    wchar_t *line = (wchar_t *)calloc(capacity, sizeof(wchar_t));
    if (line == NULL) return 127;

    int written = prefix_arg == NULL
        ? _snwprintf(line, capacity, L"\"%ls\" %ls", program, tail)
        : _snwprintf(line, capacity, L"\"%ls\" \"%ls\" %ls", program, prefix_arg, tail);
    if (written <= 0 || (size_t)written >= capacity) {
        free(line);
        return 127;
    }

    STARTUPINFOW startup;
    PROCESS_INFORMATION process;
    ZeroMemory(&startup, sizeof(startup));
    ZeroMemory(&process, sizeof(process));
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);

    int status = 127;
    if (CreateProcessW(program, line, NULL, NULL, TRUE, 0, NULL, NULL, &startup, &process)) {
        WaitForSingleObject(process.hProcess, INFINITE);
        DWORD exit_code = 1;
        GetExitCodeProcess(process.hProcess, &exit_code);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        status = (int)exit_code;
    } else {
        fwprintf(stderr, L"[orbis-codex-wrapper] 无法启动 %ls（GetLastError=%lu）\n", label, (unsigned long)GetLastError());
    }
    free(line);
    return status;
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

    const wchar_t *tail = skip_program_name(GetCommandLineW());

    if (node[0] != L'\0' && script[0] != L'\0' && file_exists(node) && file_exists(script)) {
        return run_verbatim(node, script, tail, script);
    }

    // 包装器不完整：不要让桌面版开不了。退回环境里给出的真实 CLI。
    wchar_t real[ORBIS_PATH_MAX];
    if (read_env(L"ORBIS_CODEX_REAL", real, ORBIS_PATH_MAX) && file_exists(real)) {
        return run_verbatim(real, NULL, tail, real);
    }

    fwprintf(stderr, L"[orbis-codex-wrapper] 缺少包装器运行时（node=%ls script=%ls），且没有 ORBIS_CODEX_REAL 可回退\n", node, script);
    return 127;
}
