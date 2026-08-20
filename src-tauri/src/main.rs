// 发布模式下不显示控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    dsh_desktop_lib::run()
}
