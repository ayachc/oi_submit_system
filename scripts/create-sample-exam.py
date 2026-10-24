"""Generate the self-authored, unencrypted sample exam using only Python stdlib."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


FILES = {
    "README.md": """# 信息学竞赛示例试题包

本试题包为本项目自编的功能演示题目，并非 CSP 官方试题。
压缩包未加密，无需密码；网页中的 None 表示无密码。

请阅读 a.md、b.md、c.md、d.md，分别编写程序，并在对应题目卡片提交源代码。
程序使用标准输入和标准输出，不需要进行文件读写。
可提交 C/C++、Python、Java、Pascal 源代码，每份文件不超过 1 MB，编码为 UTF-8。
系统只保存源代码，不编译、运行或自动判题。每道题保留最后一次成功提交的版本。

| 题号 | 题目 |
| --- | --- |
| a | 两数之和 |
| b | 寻找最大值 |
| c | 从小到大排序 |
| d | 区间求和 |
""",
    "a.md": """# a · 两数之和

给定两个整数 a 和 b，输出它们的和。

## 输入格式

一行，包含两个以空格分隔的整数 a、b。

## 输出格式

输出一行，包含一个整数，表示 a + b。

## 数据范围

-10^9 ≤ a, b ≤ 10^9。

## 样例输入

```text
12 30
```

## 样例输出

```text
42
```
""",
    "b.md": """# b · 寻找最大值

给定 n 个整数，输出其中最大的整数。

## 输入格式

第一行包含一个整数 n。
第二行包含 n 个以空格分隔的整数。

## 输出格式

输出一行，包含这 n 个整数中的最大值。

## 数据范围

1 ≤ n ≤ 100000；每个整数均在 [-10^9, 10^9] 范围内。

## 样例输入

```text
5
-3 8 2 8 -1
```

## 样例输出

```text
8
```
""",
    "c.md": """# c · 从小到大排序

给定 n 个整数，将它们按照从小到大的顺序输出。重复的整数需要全部保留。

## 输入格式

第一行包含一个整数 n。
第二行包含 n 个以空格分隔的整数。

## 输出格式

输出一行，包含排序后的 n 个整数，相邻整数之间用一个空格分隔。

## 数据范围

1 ≤ n ≤ 100000；每个整数均在 [-10^9, 10^9] 范围内。

## 样例输入

```text
6
9 1 4 1 -2 7
```

## 样例输出

```text
-2 1 1 4 7 9
```
""",
    "d.md": """# d · 区间求和

给定一个长度为 n 的整数序列，以及 q 次查询。
每次查询给出下标 l 和 r，请输出从第 l 个数到第 r 个数的和。
序列下标从 1 开始，查询包含两个端点。

## 输入格式

第一行包含两个整数 n、q。
第二行包含 n 个以空格分隔的整数。
接下来 q 行，每行包含两个整数 l、r，表示一次查询。

## 输出格式

输出 q 行，每行包含一个整数，表示对应查询的区间和。

## 数据范围

1 ≤ n, q ≤ 100000；1 ≤ l ≤ r ≤ n。
序列中每个整数均在 [-10^9, 10^9] 范围内，区间和可能超出 32 位有符号整数范围。

## 样例输入

```text
5 3
2 4 -1 3 6
1 3
2 5
4 4
```

## 样例输出

```text
5
12
3
```
""",
}


def main():
    archive_path = Path(__file__).resolve().parents[1] / "public" / "exam" / "day1.zip"
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(archive_path, "w", compression=ZIP_DEFLATED) as archive:
        for filename, content in FILES.items():
            entry = ZipInfo(filename, date_time=(2026, 1, 1, 0, 0, 0))
            entry.compress_type = ZIP_DEFLATED
            entry.external_attr = 0o644 << 16
            archive.writestr(entry, content.encode("utf-8"))
    with ZipFile(archive_path) as archive:
        invalid_file = archive.testzip()
        if invalid_file is not None:
            raise RuntimeError(f"ZIP validation failed: {invalid_file}")
        if archive.namelist() != list(FILES):
            raise RuntimeError("ZIP contents do not match the expected exam files")
    print(f"Created and verified {archive_path} ({archive_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
