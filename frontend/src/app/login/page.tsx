import { redirect } from "next/navigation"

import { LoginClientPage } from "./login-client"

const loginOverride = process.env.NEXT_PUBLIC_APP_LOGIN_URL

export default function LoginPage() {
  if (loginOverride && loginOverride !== "/login") {
    redirect(loginOverride)
  }

  return <LoginClientPage />
}
