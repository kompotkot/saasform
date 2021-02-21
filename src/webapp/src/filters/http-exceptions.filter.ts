import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  InternalServerErrorException
} from '@nestjs/common'
import { Request, Response } from 'express'

@Catch()
export class HttpExceptionsFilter implements ExceptionFilter {
  async catch (exception: Error, host: ArgumentsHost): Promise<any> {
    const ctx = host.switchToHttp()
    const response = ctx.getResponse<Response>()
    const request: any = ctx.getRequest<Request>()

    console.log('ex', exception)

    // This needs to be first because it is a special
    // kind of unauthrized that does not trigger any
    // logout and needs to return a 302
    if (
      exception instanceof UnauthorizedException &&
      exception.message === 'Subscription not active'
    ) {
      if (request.is('json') === true || request?.query?.json != null) {
        return response.json({
          statusCode: 302,
          message: 'Found',
          redirect: '/user/billing'
        })
      }

      return response.redirect('/user/billing')
      // TODO
      // response.redirect('/user');
    }

    const e = exception instanceof HttpException ? exception : new InternalServerErrorException()
    if (request?.query?.json != null) {
      return response
        .status(e.getStatus())
        .json(e.getResponse())
    }

    const themeRoot = request?.renderVar?.themeRoot as string ?? 'default'
    const assetsRoot: string = request?.renderVar?.assetsRoot ?? `/${themeRoot}`
    const renderVar = request?.renderVar ?? { assetsRoot }

    if (
      // view doesn't exist for tenant, revert to default
      exception.message.startsWith('Failed to lookup view')
    ) {
      response.statusCode = 500
      response.render(`${themeRoot}/500`, renderVar)
    } else if (
      exception instanceof UnauthorizedException ||
      exception instanceof ForbiddenException
    ) {
      let next: string = ''
      const originalUrl = request.originalUrl

      switch (exception.message) {
        case 'admin':
          response.redirect('/')
          break
        case 'Invalid email or password':
          response.render(`${themeRoot}/error`, { error: 'Invalid email or password' })
          break
        default:
          if (originalUrl.startsWith('/login') === true) {
            next = request.query.next
          } else {
            next = originalUrl
          }

          if (next != null && next !== '') {
            response.redirect(`/login?next=${next}`)
          } else {
            response.redirect('/login')
          }
      }
    } else if (exception instanceof NotFoundException) {
      // request.renderVar is set by publicController.getStar
      response.statusCode = 404
      response.render(`${themeRoot}/404`, renderVar)
    } else {
      console.log(exception)
      response.statusCode = 500
      response.render(`${themeRoot}/500`, renderVar)
    }
  }
}
