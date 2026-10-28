# -*- coding: utf-8 -*-
"""dsh-quit 部署脚本（用户已确认，硬闸吃过一次教训：走 file 参数而非 code）。

步骤：
1. 备份 profile/package.json 到工作区「插件安装前备份-<时间戳>/」
2. 把工作区的 dsh-quit 插件复制到 profile/node_modules/dsh-quit/
3. 在 profile/package.json 里加 dependencies.dsh-quit 与 dsh.profile.bundles 项
4. 回读校验并打印
"""
import json
import os
import shutil
import time

SRC = "/storage/Users/currentUser/Download/com.dshm.dshclient/DSH插件/dsh-quit"
WORK = "/storage/Users/currentUser/Download/com.dshm.dshclient/DSH插件"
PKG = "/data/storage/el2/base/haps/phone/files/dsh/home/profiles/ondevice/package.json"
DST = "/data/storage/el2/base/haps/phone/files/dsh/home/profiles/ondevice/node_modules/dsh-quit"


def main():
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = os.path.join(WORK, "插件安装前备份-" + stamp)
    os.makedirs(backup, exist_ok=True)

    raw = open(PKG, encoding="utf-8").read()
    open(os.path.join(backup, "package.json"), "w", encoding="utf-8").write(raw)
    print("备份:", backup)

    if os.path.exists(DST):
        print("目标已存在，先移除:", DST)
        shutil.rmtree(DST)
    shutil.copytree(SRC, DST)
    print("已复制:", DST)
    print("  内容:", sorted(os.listdir(DST)))

    data = json.loads(raw)
    data["dependencies"]["dsh-quit"] = "file:" + SRC
    bundles = data["dsh"]["profile"]["bundles"]
    if "dsh-quit" not in bundles:
        bundles.append("dsh-quit")
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    tmp = PKG + ".dsh-quit.tmp"
    open(tmp, "w", encoding="utf-8").write(text)
    os.replace(tmp, PKG)

    check = json.load(open(PKG, encoding="utf-8"))
    print()
    print("dependencies.dsh-quit =", check["dependencies"].get("dsh-quit"))
    print("bundles 末尾 3 项 =", check["dsh"]["profile"]["bundles"][-3:])
    print(
        "bundles 总数 =",
        len(check["dsh"]["profile"]["bundles"]),
        "| removeBundles =",
        check["dsh"]["profile"].get("removeBundles"),
        "| patchReload =",
        check["dsh"]["profile"].get("patchReload"),
    )
    print("package.json 行数 =", len(open(PKG, encoding="utf-8").read().splitlines()))

    # 部署后的插件包自检（确认复制完整）
    need = ["package.json", "cordis.patch.yml", "README.md", os.path.join("lib", "index.js"), os.path.join("lib", "client.js")]
    missing = [rel for rel in need if not os.path.exists(os.path.join(DST, rel))]
    print("复制完整性:", "OK" if not missing else ("缺少 " + str(missing)))


if __name__ == "__main__":
    main()
