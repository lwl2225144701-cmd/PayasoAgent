# Homebrew cask：不花钱的「装完即用」分发通道。
#
# 机制：brew 用 curl 下载，**不带浏览器的 com.apple.quarantine 隔离标记**，
# Gatekeeper 无从弹窗 —— 即使 app 只是 ad-hoc 签名（坑 9），装完也能直接开。
# 这是免费方案里最接近"拖拽即用"的体验；浏览器拖 DMG 零弹窗依旧只有
# Developer ID + 公证（$99/年，见实施手账 §9）一条路。
#
# 版本与 sha256 由 release.yml 在每次发版时自动 bump（"Sync Homebrew cask" 步）。
cask "payasoagent" do
  arch arm: "arm64"

  version "0.3.1"
  sha256 "471be1c11f43228194f4f94416d30f6f099bd3bdcaf150057fda33707b62a78b"

  url "https://github.com/lwl2225144701-cmd/PayasoAgent/releases/download/v#{version}/PayasoAgent-#{version}-#{arch}.dmg"
  name "PayasoAgent"
  desc "开箱即用的 PayasoAgent 桌面客户端：自带运行时，装完即用"
  homepage "https://github.com/lwl2225144701-cmd/PayasoAgent"

  depends_on arch: :arm64

  app "PayasoAgent.app"
end
