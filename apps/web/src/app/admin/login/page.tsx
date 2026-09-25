import { getDictionary } from "~/lib/i18n";
import { getRequestLocale } from "~/lib/i18n/server";

import { LoginForm } from "./login-form";

export default async function AdminLoginPage() {
	const copy = getDictionary(await getRequestLocale());
	return (
		<main className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center px-4 py-12">
			<h1 className="font-display text-4xl uppercase tracking-wide">
				{copy.adminLoginTitle}
			</h1>
			<LoginForm
				labels={{
					password: copy.adminPasswordLabel,
					submit: copy.adminLoginSubmit,
					error: copy.adminLoginError,
				}}
			/>
		</main>
	);
}
