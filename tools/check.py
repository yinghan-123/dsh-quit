# -*- coding: utf-8 -*-
"""dsh-quit 静态自检（本机不能跑 node，用词法扫描 + 结构断言）。

用法: python check.py <插件目录>
"""
import json
import os
import sys

KEYWORDS = {"if", "for", "while", "switch", "catch", "return", "typeof", "function", "in", "of", "new", "delete", "void", "do", "else", "try", "finally", "throw", "case", "default", "instanceof", "yield", "await"}


def lex_check(src, path):
    """扫描 JS 源码：字符串/模板/注释/正则状态机 + 括号匹配。返回 (errors, stats)。"""
    errors = []
    i = 0
    n = len(src)
    line = 1
    stack = []  # items: (char, line, prev_significant_token)
    state = "normal"  # normal | sq | dq | tpl | line_comment | block_comment | regex
    tpl_depth = 0
    prev_token = ""  # 上一个有意义的 token，用于判断 / 是除号还是正则
    while i < n:
        ch = src[i]
        nxt = src[i + 1] if i + 1 < n else ""
        if ch == "\n":
            line += 1
        if state == "normal":
            if ch == "/" and nxt == "/":
                state = "line_comment"
                i += 2
                continue
            if ch == "/" and nxt == "*":
                state = "block_comment"
                i += 2
                continue
            if ch == "'":
                state = "sq"
                i += 1
                continue
            if ch == '"':
                state = "dq"
                i += 1
                continue
            if ch == "`":
                state = "tpl"
                i += 1
                continue
            if ch == "/" and (prev_token in ("", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "return", "typeof")):
                state = "regex"
                i += 1
                continue
            if ch in "([{":
                stack.append((ch, line, prev_token))
                prev_token = ch
                i += 1
                continue
            if ch in ")]}":
                pairs = {")": "(", "]": "[", "}": "{"}
                if not stack:
                    errors.append("第 %d 行: 多余的 '%s'" % (line, ch))
                else:
                    top, top_line, _tok = stack.pop()
                    if top != pairs[ch]:
                        errors.append("第 %d 行: '%s' 与第 %d 行的 '%s' 不匹配" % (line, ch, top_line, top))
                prev_token = ch
                i += 1
                continue
            if ch.isalnum() or ch in "_$":
                j = i
                while j < n and (src[j].isalnum() or src[j] in "_$."):
                    j += 1
                word = src[i:j]
                if word in KEYWORDS:
                    prev_token = word
                else:
                    prev_token = "ident"
                i = j
                continue
            if ch.strip() != "":
                prev_token = ch
            i += 1
            continue
        if state == "line_comment":
            if ch == "\n":
                state = "normal"
            i += 1
            continue
        if state == "block_comment":
            if ch == "*" and nxt == "/":
                state = "normal"
                i += 2
                continue
            i += 1
            continue
        if state in ("sq", "dq"):
            if ch == "\\":
                i += 2
                continue
            if (state == "sq" and ch == "'") or (state == "dq" and ch == '"'):
                state = "normal"
                i += 1
                continue
            i += 1
            continue
        if state == "tpl":
            if ch == "\\":
                i += 2
                continue
            if ch == "`":
                state = "normal"
                i += 1
                continue
            if ch == "$" and nxt == "{":
                # 模板插值：当作 normal 继续扫，插入一个虚拟括号
                stack.append(("tpl{", line, prev_token))
                state = "normal"
                i += 2
                continue
            i += 1
            continue
        if state == "regex":
            if ch == "\\":
                i += 2
                continue
            if ch == "[":
                i += 1
                while i < n and src[i] != "]":
                    if src[i] == "\\":
                        i += 1
                    i += 1
                i += 1
                continue
            if ch == "/":
                state = "normal"
                i += 1
                # 吃掉 flags
                while i < n and src[i].isalpha():
                    i += 1
                prev_token = "regex"
                continue
            i += 1
            continue
    if state == "line_comment":
        state = "normal"
    if state in ("sq", "dq", "tpl", "block_comment", "regex"):
        errors.append("文件结尾仍处于未闭合状态: %s" % state)
    for ch, ln, _tok in stack:
        errors.append("第 %d 行的 '%s' 未闭合" % (ln, ch))
    return errors


def check_index(path):
    src = open(path, encoding="utf-8").read()
    errs = lex_check(src, path)
    must = [
        ("export const name = 'dsh-quit'", "导出 name"),
        ("export const inject = []", "导出 inject"),
        ("export function apply(ctx)", "导出 apply"),
        ("webServer.register", "注册 webServer 路由"),
        ("kind: 'prefix'", "prefix 路由"),
        ("process.kill", "SIGKILL 一级退出"),
        ("process.abort()", "abort 二级退出"),
        ("process.exit(0)", "结束进程（退出 App）"),
        ("_exit(int status)", "koffi/libc 兜底退出"),
        ("EXIT_DELAY_MS", "先回响应再退出的延迟"),
        ("x-dsh-quit", "CSRF 头"),
        ("isTrustedOrigin", "同源校验"),
        ("DSH_HOME", "定位 $DSH_HOME"),
        ("'quit'", "quit 动作"),
    ]
    for needle, label in must:
        if needle not in src:
            errs.append("缺少要素: %s（%r）" % (label, needle))
    # 用户已要求“去除重启”：插件只负责退出，不得再出现重启路由或重启请求
    if "ROUTE_RESTART" in src:
        errs.append("不应再有 ROUTE_RESTART（重启功能已按要求去除）")
    if "app-restart-request" in src:
        errs.append("不应再写 app-restart-request（重启功能已去除）")
    if "performRestart" in src:
        errs.append("不应再有 performRestart（重启功能已去除）")
    # 危险面：不得有外联/执行（本机回环 URL 解析 base 不算外联）
    for bad in ["child_process", "execSync", "spawnSync", "require(", "fetch(", "https://"]:
        if bad in src:
            errs.append("发现不该出现的东西: %r" % bad)
    for hit in [m.start() for m in __import__("re").finditer(r"http://", src)]:
        tail = src[hit + 7 : hit + 26]
        if not (tail.startswith("127.0.0.1") or tail.startswith("localhost")):
            errs.append("发现外部 http 地址: %r" % src[hit : hit + 40])
    return errs, len(src.splitlines())


def check_client(path):
    src = open(path, encoding="utf-8").read()
    errs = lex_check(src, path)
    must = [
        ("window.__ModuleLoader__.load({", "客户端模块协议"),
        ("id: 'dsh-quit'", "客户端 id"),
        ("factory: (require) =>", "factory"),
        ("MutationObserver", "账户菜单注入监听"),
        ('[role="menu"]', "菜单定位"),
        ("data-dsh-quit-item", "注入项标记"),
        ("shell.overlay", "浮层座位"),
        ("/dsh-quit/", "后端路由前缀"),
        ("x-dsh-quit", "CSRF 头"),
        ("--dsw-alias-label-primary", "主题 token"),
        ("--dsw-alias-state-error-primary", "危险色 token"),
        ("ctx.effect", "卸载清理"),
        ("register(", "slot 注册"),
    ]
    for needle, label in must:
        if needle not in src:
            errs.append("缺少要素: %s（%r）" % (label, needle))
    if "sidebar.footer.action" in src:
        errs.append("不该再占用侧栏底部座位（用户要求放在账户菜单里）")
    for bad in ["import ", "document.write", "eval("]:
        if bad in src:
            errs.append("发现不该出现的东西: %r" % bad)
    # 不允在 apply 里直接调用 hook（组件外调用会崩）
    if "useEffect(() => {}, [])" in src:
        errs.append("apply 里调用了 hook（非法 hook call）")
    return errs, len(src.splitlines())


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
    print("插件目录:", root)
    problems = 0

    pkg_path = os.path.join(root, "package.json")
    try:
        pkg = json.load(open(pkg_path, encoding="utf-8"))
        assert pkg["name"] == "dsh-quit", "包名"
        assert pkg["main"] == "lib/index.js", "main"
        assert pkg["exports"]["."] == "./lib/index.js", "exports ."
        assert pkg["exports"]["./client"] == "./lib/client.js", "exports client"
        assert pkg["dsh"]["bundle"]["patch"] == "./cordis.patch.yml", "bundle patch"
        assert pkg["dsh"]["client"]["inject"] == ["@deepseek-ai/dsh-client-ui-sidebar"], "client inject"
        print("[OK] package.json", pkg["name"], pkg["version"])
    except Exception as exc:  # noqa: BLE001
        problems += 1
        print("[FAIL] package.json:", exc)

    patch_path = os.path.join(root, "cordis.patch.yml")
    try:
        text = open(patch_path, encoding="utf-8").read()
        assert "- insert:" in text, "insert 段"
        assert "id: dsh-quit" in text, "id 行"
        assert "name: dsh-quit" in text, "name 行"
        print("[OK] cordis.patch.yml")
    except Exception as exc:  # noqa: BLE001
        problems += 1
        print("[FAIL] cordis.patch.yml:", exc)

    for rel, checker in (("lib/index.js", check_index), ("lib/client.js", check_client)):
        path = os.path.join(root, rel)
        try:
            errs, nlines = checker(path)
        except Exception as exc:  # noqa: BLE001
            problems += 1
            print("[FAIL] %s 读取/检查异常: %s" % (rel, exc))
            continue
        if errs:
            problems += len(errs)
            print("[FAIL] %s（%d 行）" % (rel, nlines))
            for err in errs[:25]:
                print("   -", err)
        else:
            print("[OK] %s（%d 行，词法/结构/要素全过）" % (rel, nlines))

    print()
    print("结论:", "全部通过" if problems == 0 else "有 %d 个问题" % problems)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
