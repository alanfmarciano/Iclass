// Enquanto o arquivo de uma tela chega do servidor (telas sob demanda, lib/lazyPage.js):
// fica dentro do layout, com o menu à vista, no lugar da página.
export function PageLoading() {
  return <div role="status" className="py-12 text-center text-sm text-muted">Carregando...</div>
}
